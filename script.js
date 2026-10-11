(() => {
  "use strict";

  /* =========================================================
     CONFIG (prediction contract preserved from the original app)
     ========================================================= */
  const API_BASE = "https://mansik-santulan-score-ml-engine-1.onrender.com".replace(/\/+$/, "");
  const PREDICT_URL = `${API_BASE}/predict`;
  const SCORE_MIN = 0;
  const SCORE_MAX = 10;
  const GAUGE_ARC_LENGTH = 314; // approx pi * r(100)
  const STORE_KEY = "msb.data.v1";
  const THEME_KEY = "msb.theme";
  const MAX_ASSESSMENTS = 500;
  const MAX_ACTIVITIES = 1000;

  const MOODS = [
    { v: 1, label: "Very low", emoji: "😞" },
    { v: 2, label: "Low", emoji: "🙁" },
    { v: 3, label: "Neutral", emoji: "😐" },
    { v: 4, label: "Good", emoji: "🙂" },
    { v: 5, label: "Very good", emoji: "😄" },
  ];
  const moodByValue = (v) => MOODS.find((m) => m.v === v);

  const INPUT_LABELS = {
    age: "Age", gender: "Gender", country: "Country", academic_level: "Academic level",
    most_used_platform: "Most-used platform", purpose_of_use: "Primary purpose",
    avg_daily_usage_hours: "Daily screen time (h)", daily_unlocks: "Daily phone unlocks",
    study_hours: "Study hours/day", physical_activity_hours: "Physical activity (h/day)",
    sleep_hours_per_night: "Sleep/night (h)", stress_level: "Perceived stress",
  };

  /* =========================================================
     SMALL HELPERS
     ========================================================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Safe DOM builder: text is always added as text nodes, never as HTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    kids.flat().forEach((kid) => {
      if (kid == null || kid === false) return;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return el;
  }
  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "i");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const fmtLong = (d) => d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const fmtShort = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const fmtDateTime = (ts) => new Date(ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const fmtClock = (secs) => { const s = Math.max(0, Math.ceil(secs)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  /* =========================================================
     STORAGE (localStorage, versioned, defensive)
     ========================================================= */
  const defaultData = () => ({ v: 1, assessments: [], moods: {}, activities: [], badges: {} });

  function sanitize(p) {
    const d = defaultData();
    if (!p || typeof p !== "object") return d;
    if (Array.isArray(p.assessments)) {
      d.assessments = p.assessments
        .filter((a) => a && typeof a.score === "number" && isFinite(a.score) && typeof a.ts === "number")
        .map((a) => ({ id: String(a.id || a.ts), ts: a.ts, score: a.score, inputs: a.inputs && typeof a.inputs === "object" ? a.inputs : {} }))
        .sort((a, b) => a.ts - b.ts)
        .slice(-MAX_ASSESSMENTS);
    }
    if (p.moods && typeof p.moods === "object") {
      for (const [k, m] of Object.entries(p.moods)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && m && Number.isInteger(m.mood) && m.mood >= 1 && m.mood <= 5) {
          d.moods[k] = { mood: m.mood, note: typeof m.note === "string" ? m.note.slice(0, 500) : "", ts: Number(m.ts) || Date.now() };
        }
      }
    }
    if (Array.isArray(p.activities)) {
      d.activities = p.activities
        .filter((a) => a && typeof a.ts === "number" && typeof a.type === "string")
        .map((a) => ({ ts: a.ts, type: a.type.slice(0, 20), seconds: Number(a.seconds) || 0 }))
        .slice(-MAX_ACTIVITIES);
    }
    if (p.badges && typeof p.badges === "object") {
      for (const [k, v] of Object.entries(p.badges)) if (typeof v === "number") d.badges[k.slice(0, 40)] = v;
    }
    return d;
  }

  let storageAvailable = true;
  function loadData() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? sanitize(JSON.parse(raw)) : defaultData();
    } catch (e) {
      storageAvailable = storageProbe();
      return defaultData();
    }
  }
  function storageProbe() {
    try { localStorage.setItem("msb.probe", "1"); localStorage.removeItem("msb.probe"); return true; } catch (e) { return false; }
  }
  let data = loadData();
  let saveWarned = false;
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); storageAvailable = true; }
    catch (e) {
      storageAvailable = false;
      if (!saveWarned) { saveWarned = true; toast("Couldn't save to this browser (storage may be blocked or full). Your data won't persist.", "error", 6000); }
    }
  }

  /* =========================================================
     TOASTS, DIALOGS, CONFETTI
     ========================================================= */
  function toast(msg, type = "info", ms = 3800) {
    const box = $("#toasts");
    while (box.children.length >= 4) box.firstChild.remove();
    const t = h("div", { class: `toast toast-${type}`, role: type === "error" ? "alert" : "status" }, msg);
    box.append(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
  }

  function openDialog(dlg) {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  }
  function confirmDialog(title, text, okLabel = "Confirm") {
    return new Promise((resolve) => {
      const dlg = $("#confirm-dialog");
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      $("#confirm-ok").textContent = okLabel;
      const onClose = () => { dlg.removeEventListener("close", onClose); resolve(dlg.returnValue === "ok"); };
      dlg.returnValue = "cancel";
      dlg.addEventListener("close", onClose);
      openDialog(dlg);
    });
  }

  function confetti() {
    if (reduceMotion()) return;
    const box = $("#confetti");
    const colors = ["#9BE7B0", "#A99BFF", "#F3F6F3", "#6FCF97"];
    for (let i = 0; i < 36; i++) {
      const s = h("span");
      s.style.left = `${Math.random() * 100}%`;
      s.style.background = colors[i % colors.length];
      s.style.setProperty("--x", `${(Math.random() - 0.5) * 240}px`);
      s.style.setProperty("--r", `${300 + Math.random() * 500}deg`);
      s.style.setProperty("--d", `${1.4 + Math.random() * 1.2}s`);
      s.style.animationDelay = `${Math.random() * 0.25}s`;
      box.append(s);
    }
    setTimeout(() => { box.textContent = ""; }, 3200);
  }

  /* =========================================================
     THEME
     ========================================================= */
  const getTheme = () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  function applyTheme(t, persist) {
    document.documentElement.setAttribute("data-theme", t);
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#F3F6F3" : "#0B0F0D");
    const btn = $("#theme-toggle");
    btn.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
    if (persist) { try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ } }
    renderCharts();
  }
  $("#theme-toggle").addEventListener("click", () => applyTheme(getTheme() === "dark" ? "light" : "dark", true));

  /* =========================================================
     NAVBAR
     ========================================================= */
  const navMenu = $("#nav-menu");
  const navBurger = $("#nav-burger");
  const navIndicator = $("#nav-indicator");
  const navLinks = $$("#nav-links a");
  const sectionIds = navLinks.map((a) => a.dataset.section);

  function setMenu(open) {
    navMenu.classList.toggle("open", open);
    navBurger.setAttribute("aria-expanded", String(open));
    navBurger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }
  navBurger.addEventListener("click", () => setMenu(!navMenu.classList.contains("open")));
  navLinks.forEach((a) => a.addEventListener("click", () => setMenu(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && navMenu.classList.contains("open")) { setMenu(false); navBurger.focus(); }
  });
  document.addEventListener("click", (e) => {
    if (navMenu.classList.contains("open") && !e.target.closest("#nav")) setMenu(false);
  });

  let activeSection = null;
  function updateActiveNav() {
    let cur = sectionIds[0];
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 120) cur = id;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = sectionIds[sectionIds.length - 1];
    if (cur === activeSection) return;
    activeSection = cur;
    navLinks.forEach((a) => {
      if (a.dataset.section === cur) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
    moveIndicator();
  }
  function moveIndicator() {
    const a = navLinks.find((x) => x.dataset.section === activeSection);
    if (!a || !navIndicator || window.getComputedStyle(navIndicator).display === "none") return;
    navIndicator.style.width = `${a.offsetWidth - 16}px`;
    navIndicator.style.transform = `translateX(${a.offsetLeft + 8}px)`;
  }
  let navTick = false;
  window.addEventListener("scroll", () => {
    if (navTick) return;
    navTick = true;
    requestAnimationFrame(() => { updateActiveNav(); navTick = false; });
  }, { passive: true });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 980) setMenu(false);
    moveIndicator();
  });

  function goTo(id, focusSel) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    if (focusSel) setTimeout(() => { const f = $(focusSel); if (f) f.focus({ preventScroll: true }); }, reduceMotion() ? 0 : 450);
  }

  /* =========================================================
     DERIVED STATS: streaks, badges
     ========================================================= */
  function computeStreaks() {
    const days = new Set(Object.keys(data.moods));
    const sorted = [...days].sort();
    let best = 0, run = 0, prev = null;
    for (const k of sorted) {
      run = prev && dateKey(addDays(parseKey(prev), 1)) === k ? run + 1 : 1;
      best = Math.max(best, run);
      prev = k;
    }
    // Current streak: counts back from today if checked in today, otherwise from yesterday
    // (today isn't "missed" until the day is over).
    let anchor = new Date();
    if (!days.has(dateKey(anchor))) anchor = addDays(anchor, -1);
    let current = 0;
    while (days.has(dateKey(anchor))) { current++; anchor = addDays(anchor, -1); }
    return { current, best };
  }

  function daysSinceFirstActivity() {
    const keys = [...Object.keys(data.moods)];
    data.assessments.forEach((a) => keys.push(dateKey(new Date(a.ts))));
    data.activities.forEach((a) => keys.push(dateKey(new Date(a.ts))));
    if (!keys.length) return 0;
    keys.sort();
    return Math.round((startOfDay(new Date()) - parseKey(keys[0])) / 864e5);
  }

  function stats() {
    const { current, best } = computeStreaks();
    return {
      checkins: Object.keys(data.moods).length,
      assessments: data.assessments.length,
      activities: data.activities.length,
      current, best,
      sinceFirst: daysSinceFirstActivity(),
    };
  }

  const BADGES = [
    { id: "first_checkin", name: "First Check-In", desc: "Record your first mood check-in.", icon: "smile",
      test: (s) => ({ done: s.checkins >= 1, pct: Math.min(1, s.checkins / 1), label: `${Math.min(s.checkins, 1)} / 1 check-in` }) },
    { id: "first_assessment", name: "First Assessment", desc: "Complete your first ML assessment.", icon: "clipboard",
      test: (s) => ({ done: s.assessments >= 1, pct: Math.min(1, s.assessments / 1), label: `${Math.min(s.assessments, 1)} / 1 assessment` }) },
    { id: "calm_moment", name: "Calm Moment", desc: "Finish a breathing, grounding or timer session.", icon: "wind",
      test: (s) => ({ done: s.activities >= 1, pct: Math.min(1, s.activities / 1), label: `${Math.min(s.activities, 1)} / 1 session` }) },
    { id: "three_day", name: "Three-Day Reflection", desc: "Check in 3 days in a row.", icon: "flame",
      test: (s) => ({ done: s.best >= 3, pct: Math.min(1, s.best / 3), label: `Best run: ${Math.min(s.best, 3)} / 3 days` }) },
    { id: "seven_day", name: "Seven-Day Reflection", desc: "Check in 7 days in a row.", icon: "flame",
      test: (s) => ({ done: s.best >= 7, pct: Math.min(1, s.best / 7), label: `Best run: ${Math.min(s.best, 7)} / 7 days` }) },
    { id: "first_week", name: "First Week Completed", desc: "7 days since your first activity, with at least 3 check-ins.", icon: "award",
      test: (s) => ({ done: s.sinceFirst >= 7 && s.checkins >= 3, pct: Math.min(1, (Math.min(s.sinceFirst / 7, 1) + Math.min(s.checkins / 3, 1)) / 2), label: `${Math.min(s.sinceFirst, 7)} / 7 days · ${Math.min(s.checkins, 3)} / 3 check-ins` }) },
    { id: "consistency", name: "Consistency Milestone", desc: "Check in on 14 different days (not necessarily consecutive).", icon: "award",
      test: (s) => ({ done: s.checkins >= 14, pct: Math.min(1, s.checkins / 14), label: `${Math.min(s.checkins, 14)} / 14 days` }) },
  ];

  let justUnlocked = new Set();
  function checkBadges() {
    const s = stats();
    const fresh = [];
    BADGES.forEach((b) => {
      if (!data.badges[b.id] && b.test(s).done) { data.badges[b.id] = Date.now(); fresh.push(b); }
    });
    if (fresh.length) {
      save();
      justUnlocked = new Set(fresh.map((b) => b.id));
      renderMilestones();
      fresh.forEach((b) => toast(`Badge unlocked: ${b.name}`, "success", 4500));
      if (fresh.some((b) => ["three_day", "seven_day", "first_week", "consistency"].includes(b.id))) confetti();
    }
  }

  function logActivity(type, seconds) {
    data.activities.push({ ts: Date.now(), type, seconds: Math.round(seconds) });
    if (data.activities.length > MAX_ACTIVITIES) data.activities.splice(0, data.activities.length - MAX_ACTIVITIES);
    save();
    renderDashboard();
    renderMilestones();
    checkBadges();
  }

  /* =========================================================
     RECOMMENDATIONS (transparent, rule-based; general wellness only)
     ========================================================= */
  function buildRecommendations(inputs) {
    const out = [];
    const num = (k) => (inputs && typeof inputs[k] === "number" && isFinite(inputs[k]) ? inputs[k] : null);
    const sleep = num("sleep_hours_per_night"), act = num("physical_activity_hours");
    const screen = num("avg_daily_usage_hours"), unlocks = num("daily_unlocks"), study = num("study_hours");
    const stress = inputs && inputs.stress_level;

    if (sleep !== null && sleep < 7) {
      out.push({ title: "Keep a steady sleep routine", text: "Going to bed and waking at similar times can help you feel more rested. Many adults aim for 7–9 hours, though needs vary from person to person.", basis: `You entered ${sleep} h of sleep per night.` });
    }
    if (stress === "High" || stress === "Very High") {
      out.push({ title: "Try a short breathing exercise", text: "A couple of minutes of slow breathing is a low-effort way to pause. You can stop at any time.", basis: `You reported ${String(stress).toLowerCase()} stress.`, action: { label: "Open breathing exercise", run: () => goTo("breathing-card", "#breath-start") } });
    }
    if (stress === "Very High") {
      out.push({ title: "Consider talking to someone", text: "If stress feels overwhelming or won't ease, reaching out to a friend, family member or a qualified professional can help. You don't have to handle it alone.", basis: "You reported very high stress." });
    }
    if (act !== null && act < 0.5) {
      out.push({ title: "Add a gentle movement break", text: "If it feels okay for you, a short walk or some stretching can be a small way to break up the day.", basis: `You entered ${act} h of physical activity per day.` });
    }
    if ((screen !== null && screen >= 6) || (unlocks !== null && unlocks >= 100)) {
      const bits = [];
      if (screen !== null && screen >= 6) bits.push(`${screen} h of screen time`);
      if (unlocks !== null && unlocks >= 100) bits.push(`${unlocks} unlocks a day`);
      out.push({ title: "Plan a few screen-free pauses", text: "Short breaks away from your phone, like during meals or before bed, can give your attention a rest.", basis: `You entered ${bits.join(" and ")}.` });
    }
    if (study !== null && study >= 8) {
      out.push({ title: "Build rest into long study days", text: "Short breaks between study blocks can make long days feel more manageable.", basis: `You entered ${study} h of study per day.` });
    }
    return out;
  }

  function dashboardRecommendations() {
    const out = [];
    const latest = data.assessments.at(-1);
    if (latest) buildRecommendations(latest.inputs).slice(0, 3).forEach((r) => out.push(r));

    const today = data.moods[dateKey()];
    if (today && today.mood <= 2) {
      out.unshift({ title: "Be gentle with yourself today", text: "A grounding exercise can help bring you back to the present. If things feel heavy for a while, talking with someone you trust or a professional can help.", basis: `Your check-in today: ${moodByValue(today.mood).label}.`, action: { label: "Open grounding exercise", run: () => goTo("grounding-card", "#ground-next") } });
    }

    // Neutral reminder if there has been no recent check-in
    const keys = Object.keys(data.moods).sort();
    const last = keys.at(-1);
    const gap = last ? Math.round((startOfDay(new Date()) - parseKey(last)) / 864e5) : Infinity;
    if (gap >= 3) {
      out.push({ title: "Check in whenever you're ready", text: gap === Infinity ? "A check-in takes under a minute and builds a picture over time." : "It's been a few days since your last check-in. No pressure — it takes under a minute whenever you'd like.", basis: gap === Infinity ? "No check-ins yet." : `Last check-in: ${fmtShort(parseKey(last))}.`, action: { label: "Check in", run: () => goTo("mood") } });
    }
    return out;
  }

  function renderRecoList(listEl, recs, emptyText) {
    listEl.replaceChildren();
    if (!recs.length) { listEl.append(h("li", { class: "stat-empty" }, emptyText)); return; }
    recs.forEach((r) => {
      listEl.append(h("li", { class: "reco" },
        h("h4", { text: r.title }),
        h("p", { text: r.text }),
        r.basis ? h("p", { class: "basis", text: `Based on: ${r.basis}` }) : null,
        r.action ? h("button", { type: "button", class: "link-btn", onclick: r.action.run }, r.action.label, icon("arrow")) : null
      ));
    });
  }

  /* =========================================================
     DASHBOARD
     ========================================================= */
  const setBody = (id, ...nodes) => $(id).replaceChildren(...nodes.flat().filter(Boolean));
  let renderedDay = dateKey();

  function renderDashboard() {
    renderedDay = dateKey();
    $("#today-date").textContent = fmtLong(new Date());

    const [prev, latest] = [data.assessments.at(-2), data.assessments.at(-1)];
    if (latest) {
      setBody("#stat-latest-body",
        h("p", { class: "stat-value" }, latest.score.toFixed(2), h("small", {}, ` / ${SCORE_MAX}`)),
        h("p", { class: "stat-sub", text: fmtDateTime(latest.ts) }));
    } else {
      setBody("#stat-latest-body",
        h("p", { class: "stat-empty", text: "No assessment yet." }),
        h("button", { type: "button", class: "link-btn", "data-action": "assess" }, "Take your first", icon("arrow")));
    }
    if (prev) {
      const diff = latest.score - prev.score;
      const txt = Math.abs(diff) < 0.005 ? "No change vs. previous" : `${diff > 0 ? "Up" : "Down"} ${Math.abs(diff).toFixed(2)} from here`;
      setBody("#stat-prev-body",
        h("p", { class: "stat-value" }, prev.score.toFixed(2), h("small", {}, ` / ${SCORE_MAX}`)),
        h("p", { class: "stat-sub", text: `${fmtDateTime(prev.ts)} · ${txt}` }));
    } else {
      setBody("#stat-prev-body", h("p", { class: "stat-empty", text: latest ? "Only one assessment so far." : "Available after two assessments." }));
    }

    const today = data.moods[dateKey()];
    if (today) {
      const m = moodByValue(today.mood);
      setBody("#stat-mood-body",
        h("p", { class: "stat-value" }, m.emoji, " ", h("small", {}, m.label)),
        h("p", { class: "stat-sub", text: today.note ? "Journal entry saved" : "No journal entry" }));
    } else {
      setBody("#stat-mood-body",
        h("p", { class: "stat-empty", text: "No check-in yet today." }),
        h("button", { type: "button", class: "link-btn", "data-action": "mood" }, "Check in", icon("arrow")));
    }

    const s = computeStreaks();
    setBody("#stat-streak-body",
      h("p", { class: "stat-value" }, String(s.current), h("small", {}, s.current === 1 ? " day" : " days")),
      h("p", { class: "stat-sub", text: s.best ? `Longest: ${s.best} ${s.best === 1 ? "day" : "days"}` : "Starts with a check-in." }));

    const weekAgo = Date.now() - 7 * 864e5;
    const week = data.activities.filter((a) => a.ts >= weekAgo).length;
    setBody("#stat-act-body",
      h("p", { class: "stat-value" }, String(data.activities.length), h("small", {}, data.activities.length === 1 ? " session" : " sessions")),
      h("p", { class: "stat-sub", text: data.activities.length ? `${week} in the last 7 days` : "Try the Wellness Zone." }));

    renderRecoList($("#reco-list"), dashboardRecommendations(), "Nothing specific right now — take an assessment or check in to get personalised suggestions.");
  }

  // Global action delegation (quick actions, result buttons, empty-state links)
  const ACTIONS = {
    assess: () => goTo("assessment", "#age"),
    mood: () => goTo("mood"),
    progress: () => goTo("insights"),
    breathe: () => goTo("breathing-card", "#breath-start"),
    report: () => openReport(),
    "open-settings": () => openSettings(),
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const fn = ACTIONS[b.dataset.action];
    if (fn) fn();
  });

  /* =========================================================
     ASSESSMENT — original prediction flow, preserved
     ========================================================= */
  const form = $("#predict-form");
  const submitBtn = $("#submit-btn");
  const resetBtn = $("#reset-btn");
  const errorRetryBtn = $("#error-retry-btn");
  const stateIdle = $("#state-idle");
  const stateLoading = $("#state-loading");
  const stateResult = $("#state-result");
  const stateError = $("#state-error");
  const scoreNumberEl = $("#score-number");
  const scoreBandEl = $("#score-band");
  const scoreContextEl = $("#score-context");
  const scoreCompareEl = $("#score-compare");
  const gaugeFill = $("#gauge-fill");
  const errorLabelEl = $("#error-label");
  const errorCopyEl = $("#error-copy");
  const loadingCopyEl = $("#loading-copy");
  const LOADING_COPY_DEFAULT = loadingCopyEl.textContent;
  let isSubmitting = false;

  // Tick marks (0..10, every 2 units)
  function drawTicks() {
    $$(".gauge-ticks").forEach((g) => {
      g.replaceChildren();
      const cx = 120, cy = 140, rOuter = 100, rInner = 90;
      for (let i = 0; i <= 10; i += 2) {
        const angle = Math.PI - (i / 10) * Math.PI;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", (cx + rOuter * Math.cos(angle)).toFixed(1));
        line.setAttribute("y1", (cy - rOuter * Math.sin(angle)).toFixed(1));
        line.setAttribute("x2", (cx + rInner * Math.cos(angle)).toFixed(1));
        line.setAttribute("y2", (cy - rInner * Math.sin(angle)).toFixed(1));
        g.appendChild(line);
      }
    });
  }
  drawTicks();

  // Segmented stress control
  const segGroup = $("#stress_level_group");
  const stressHiddenInput = $("#stress_level");
  const segBtns = $$(".seg-btn", segGroup);
  function selectStress(btn) {
    segBtns.forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    stressHiddenInput.value = btn.dataset.value;
    clearFieldError(stressHiddenInput);
    updateFormProgress();
  }
  segBtns.forEach((btn, i) => {
    btn.tabIndex = i === 0 ? 0 : -1;
    btn.addEventListener("click", () => selectStress(btn));
    btn.addEventListener("keydown", (e) => {
      const k = e.key;
      if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(k)) return;
      e.preventDefault();
      const dir = k === "ArrowRight" || k === "ArrowDown" ? 1 : -1;
      const next = segBtns[(i + dir + segBtns.length) % segBtns.length];
      next.focus();
      selectStress(next);
    });
  });

  // Field-level error helpers
  const fieldWrapper = (input) => input.closest(".field");
  function setFieldError(input, message) {
    const wrap = fieldWrapper(input);
    if (!wrap) return;
    wrap.classList.add("field-error");
    const msgEl = $(".error-msg", wrap);
    if (msgEl) msgEl.textContent = message;
    if (input.type !== "hidden") input.setAttribute("aria-invalid", "true");
  }
  function clearFieldError(input) {
    const wrap = fieldWrapper(input);
    if (!wrap) return;
    wrap.classList.remove("field-error");
    const msgEl = $(".error-msg", wrap);
    if (msgEl) msgEl.textContent = "";
    input.removeAttribute("aria-invalid");
  }
  function clearAllErrors() {
    $$(".field", form).forEach((f) => f.classList.remove("field-error"));
    $$(".error-msg", form).forEach((m) => (m.textContent = ""));
    $$("[aria-invalid]", form).forEach((el) => el.removeAttribute("aria-invalid"));
  }

  // Client-side validation mirroring the StudentData model
  function validate(payload) {
    const errors = [];
    const numericChecks = [
      ["age", 10, 100], ["avg_daily_usage_hours", 0, 24], ["daily_unlocks", 0, Infinity],
      ["study_hours", 0, 24], ["physical_activity_hours", 0, 24], ["sleep_hours_per_night", 0, 24],
    ];
    numericChecks.forEach(([key, min, max]) => {
      const input = document.getElementById(key);
      const val = payload[key];
      if (val === "" || val === null || Number.isNaN(val)) errors.push([input, "This field is required."]);
      else if (val < min || val > max) errors.push([input, `Must be between ${min} and ${max === Infinity ? "0+" : max}.`]);
    });
    ["gender", "country", "academic_level", "most_used_platform", "purpose_of_use"].forEach((key) => {
      const input = document.getElementById(key);
      if (!payload[key] || String(payload[key]).trim() === "") errors.push([input, "This field is required."]);
    });
    if (!payload.stress_level) errors.push([stressHiddenInput, "Pick a stress level."]);
    return errors;
  }

  // Gather form data into the exact StudentData shape
  function collectPayload() {
    const fd = new FormData(form);
    const num = (k, parse) => (fd.get(k) === "" || fd.get(k) === null ? NaN : parse(fd.get(k)));
    return {
      age: num("age", (v) => parseInt(v, 10)),
      gender: fd.get("gender") || "",
      country: (fd.get("country") || "").trim(),
      academic_level: fd.get("academic_level") || "",
      most_used_platform: fd.get("most_used_platform") || "",
      purpose_of_use: fd.get("purpose_of_use") || "",
      avg_daily_usage_hours: num("avg_daily_usage_hours", parseFloat),
      daily_unlocks: num("daily_unlocks", (v) => parseInt(v, 10)),
      study_hours: num("study_hours", parseFloat),
      physical_activity_hours: num("physical_activity_hours", parseFloat),
      sleep_hours_per_night: num("sleep_hours_per_night", parseFloat),
      stress_level: fd.get("stress_level") || "",
    };
  }

  // Form completion progress
  function updateFormProgress() {
    const p = collectPayload();
    const done = Object.values(p).filter((v) => v !== "" && !(typeof v === "number" && Number.isNaN(v))).length;
    const total = 12;
    $("#form-progress-text").textContent = `${done} of ${total} answered`;
    $("#form-progress-fill").style.width = `${(done / total) * 100}%`;
    const bar = $("#form-progress-bar");
    bar.setAttribute("aria-valuenow", String(done));
    bar.setAttribute("aria-valuetext", `${done} of ${total} answered`);
  }

  // UI state switching
  function showState(name) {
    [stateIdle, stateLoading, stateResult, stateError].forEach((el) => (el.hidden = true));
    ({ idle: stateIdle, loading: stateLoading, result: stateResult, error: stateError }[name]).hidden = false;
  }
  function setSubmitting(on) {
    submitBtn.disabled = on;
    submitBtn.classList.toggle("loading", on);
    submitBtn.setAttribute("aria-busy", String(on));
  }

  // Describes only the position on the 0-10 scale. These are NOT clinical categories.
  function positionText(score) {
    const frac = (score - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
    const third = frac < 1 / 3 ? "lower third" : frac < 2 / 3 ? "middle third" : "upper third";
    return `That sits in the ${third} of the ${SCORE_MIN}–${SCORE_MAX} scale. This describes position on the scale only — it isn't a clinical category.`;
  }

  let countRaf = 0;
  function countUp(el, to, ms = 900) {
    cancelAnimationFrame(countRaf);
    if (reduceMotion()) { el.textContent = to.toFixed(2); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      el.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(2);
      if (p < 1) countRaf = requestAnimationFrame(step);
    };
    countRaf = requestAnimationFrame(step);
  }

  function renderResult(score, payload, prev) {
    const clamped = Math.max(SCORE_MIN, Math.min(SCORE_MAX, score));
    const outside = clamped !== score;

    scoreBandEl.textContent = `Predicted score: ${score.toFixed(2)} out of ${SCORE_MAX}`;
    scoreContextEl.textContent = positionText(clamped) + (outside ? ` (The returned value is outside the ${SCORE_MIN}–${SCORE_MAX} display range, so the gauge is capped.)` : "");

    if (prev) {
      const diff = score - prev.score;
      scoreCompareEl.textContent = Math.abs(diff) < 0.005
        ? `Same as your previous result (${prev.score.toFixed(2)}).`
        : `${diff > 0 ? "Up" : "Down"} ${Math.abs(diff).toFixed(2)} from your previous result (${prev.score.toFixed(2)}). One change isn't a trend.`;
    } else scoreCompareEl.textContent = "";

    $("#gauge-result").setAttribute("aria-label", `Score gauge: ${score.toFixed(2)} out of ${SCORE_MAX}`);
    $("#score-sr").textContent = `Predicted score: ${score.toFixed(2)} out of ${SCORE_MAX}. ${positionText(clamped)}`;

    showState("result");
    countUp(scoreNumberEl, score);

    gaugeFill.style.transition = "none";
    gaugeFill.style.strokeDashoffset = String(GAUGE_ARC_LENGTH);
    void gaugeFill.getBoundingClientRect();
    requestAnimationFrame(() => {
      gaugeFill.style.transition = "";
      gaugeFill.style.strokeDashoffset = String(GAUGE_ARC_LENGTH * (1 - (clamped - SCORE_MIN) / (SCORE_MAX - SCORE_MIN)));
    });

    renderRecoList($("#result-reco"), buildRecommendations(payload), "Your answers don't trigger any specific suggestions. Regular check-ins can help you notice patterns over time.");
    $("#result-extra").hidden = false;
  }

  function renderError(label, copy) {
    errorLabelEl.textContent = label;
    errorCopyEl.textContent = copy;
    showState("error");
  }

  // Parse FastAPI / Pydantic 422 responses into field-level messages where possible
  function applyServerValidationErrors(detail) {
    if (!Array.isArray(detail)) return false;
    let matched = false;
    detail.forEach((err) => {
      const field = Array.isArray(err.loc) ? err.loc[err.loc.length - 1] : null;
      const input = field ? document.getElementById(field) : null;
      const target = field === "stress_level" ? stressHiddenInput : input;
      if (target) { setFieldError(target, err.msg || "Invalid value."); matched = true; }
    });
    return matched;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return; // prevent duplicate submissions
    clearAllErrors();

    const payload = collectPayload();
    const clientErrors = validate(payload);
    if (clientErrors.length > 0) {
      clientErrors.forEach(([input, msg]) => input && setFieldError(input, msg));
      const first = clientErrors[0][0];
      if (first) (first.type === "hidden" ? segBtns[0] : first).focus();
      toast("Please check the highlighted fields.", "error");
      return;
    }

    isSubmitting = true;
    setSubmitting(true);
    showState("loading");
    if (window.matchMedia("(max-width: 920px)").matches) $("#result-panel").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });

    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 70000);
    const wakeTimer = setTimeout(() => { loadingCopyEl.textContent = "Still working — the server can take up to a minute to wake up on the first request."; }, 6000);

    try {
      const res = await fetch(PREDICT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        const matched = body && applyServerValidationErrors(body.detail);
        renderError("Check your inputs", matched
          ? "The API rejected a few fields — details are marked on the form."
          : "The API rejected this submission. Please review your inputs and try again.");
        return;
      }
      if (!res.ok) {
        let detailMsg = `The API responded with status ${res.status}.`;
        const body = await res.json().catch(() => null);
        if (body && typeof body.detail === "string") detailMsg = body.detail;
        renderError("Prediction failed", detailMsg);
        return;
      }

      const body = await res.json().catch(() => null);
      const score = body ? body.predicted_mental_health_score : undefined;
      if (typeof score !== "number" || !isFinite(score)) {
        renderError("Unexpected response", "The API responded, but the score was missing or malformed.");
        return;
      }

      const prev = data.assessments.at(-1) || null;
      data.assessments.push({ id: String(Date.now()), ts: Date.now(), score, inputs: payload });
      if (data.assessments.length > MAX_ASSESSMENTS) data.assessments.shift();
      save();
      renderResult(score, payload, prev);
      renderAll();
      checkBadges();
      const panel = $("#result-panel").getBoundingClientRect();
      if (panel.bottom < 0 || panel.top > window.innerHeight) $("#result-panel").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    } catch (err) {
      if (err && err.name === "AbortError") {
        renderError("Request timed out", "The server took too long to respond. It may be waking up — please try again in a moment.");
      } else {
        renderError("Can't reach the server", `Couldn't connect to the prediction service. Check your internet connection and try again. (Endpoint: ${API_BASE})`);
      }
    } finally {
      clearTimeout(abortTimer);
      clearTimeout(wakeTimer);
      loadingCopyEl.textContent = LOADING_COPY_DEFAULT;
      isSubmitting = false;
      setSubmitting(false);
    }
  });

  // live-clear errors as the user edits
  $$("input, select", form).forEach((el) => {
    const onEdit = () => { clearFieldError(el); updateFormProgress(); };
    el.addEventListener("input", onEdit);
    el.addEventListener("change", onEdit);
  });
  resetBtn.addEventListener("click", () => {
    showState("idle");
    $("#result-extra").hidden = true;
    goTo("assessment", "#age");
  });
  errorRetryBtn.addEventListener("click", () => showState("idle"));

  /* =========================================================
     MOOD TRACKER
     ========================================================= */
  let selectedKey = dateKey();
  let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const moodOptions = $("#mood-options");
  MOODS.forEach((m) => {
    moodOptions.append(h("label", { class: "mood-opt" },
      h("input", { type: "radio", name: "mood", value: String(m.v) }),
      h("span", { class: "mood-face", "aria-hidden": "true", text: m.emoji }),
      h("span", { class: "mood-label", text: m.label })));
  });
  const moodNote = $("#mood-note");
  const moodErr = $("#mood-error");

  function renderMoodForm() {
    const entry = data.moods[selectedKey];
    const isToday = selectedKey === dateKey();
    $("#mood-form-title").textContent = isToday ? "Today" : "Past entry";
    $("#mood-date-label").textContent = fmtLong(parseKey(selectedKey));
    $$("input[name=mood]", moodOptions).forEach((r) => { r.checked = !!entry && Number(r.value) === entry.mood; });
    moodNote.value = entry ? entry.note : "";
    $("#mood-count").textContent = String(moodNote.value.length);
    $("#mood-mode").hidden = !entry;
    $("#mood-delete").hidden = !entry;
    $("#mood-save span").textContent = entry ? "Update check-in" : "Save check-in";
    moodErr.hidden = true;
  }
  moodNote.addEventListener("input", () => { $("#mood-count").textContent = String(moodNote.value.length); });
  moodOptions.addEventListener("change", () => { moodErr.hidden = true; });

  $("#mood-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const sel = $("input[name=mood]:checked", moodOptions);
    if (!sel) { moodErr.hidden = false; return; }
    if (selectedKey > dateKey()) return; // never allow future dates
    const existing = data.moods[selectedKey];
    data.moods[selectedKey] = { mood: Number(sel.value), note: moodNote.value.trim().slice(0, 500), ts: existing ? existing.ts : Date.now() };
    save();
    toast(existing ? "Check-in updated." : "Check-in saved. Thanks for showing up for yourself.", "success");
    renderAll();
    checkBadges();
  });

  $("#mood-delete").addEventListener("click", async () => {
    const ok = await confirmDialog("Delete this entry?", `This removes your check-in and journal text for ${fmtLong(parseKey(selectedKey))}. It can't be undone.`, "Delete");
    if (!ok) return;
    delete data.moods[selectedKey];
    save();
    toast("Entry deleted.", "info");
    renderAll();
  });

  function renderCalendar() {
    const grid = $("#cal-grid");
    grid.replaceChildren();
    $("#cal-title").textContent = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first
    const days = new Date(y, m + 1, 0).getDate();
    const todayKey = dateKey();
    for (let i = 0; i < lead; i++) grid.append(h("span", { class: "cal-day cal-blank", "aria-hidden": "true" }));
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${pad(m + 1)}-${pad(d)}`;
      const entry = data.moods[key];
      const mood = entry ? moodByValue(entry.mood) : null;
      const btn = h("button", {
        type: "button",
        class: ["cal-day", entry ? "has-entry" : "", key === todayKey ? "today" : "", key === selectedKey ? "selected" : ""].filter(Boolean).join(" "),
        "aria-label": `${fmtLong(new Date(y, m, d))}: ${mood ? mood.label : "no entry"}`,
        "aria-pressed": String(key === selectedKey),
        onclick: () => { selectedKey = key; renderMoodForm(); renderCalendar(); },
      }, h("span", { text: String(d) }), mood ? h("span", { class: "cal-emoji", "aria-hidden": "true", text: mood.emoji }) : null);
      if (key > todayKey) btn.disabled = true;
      grid.append(btn);
    }
    const now = new Date();
    $("#cal-next").disabled = y === now.getFullYear() && m === now.getMonth();
  }
  $("#cal-prev").addEventListener("click", () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
  $("#cal-next").addEventListener("click", () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });

  function renderMoodList() {
    const list = $("#mood-list");
    list.replaceChildren();
    const keys = Object.keys(data.moods).sort().reverse().slice(0, 6);
    if (!keys.length) { list.append(h("li", { class: "empty" }, "No check-ins yet. Your entries will appear here.")); return; }
    keys.forEach((k) => {
      const e = data.moods[k], m = moodByValue(e.mood);
      list.append(h("li", {}, h("button", {
        type: "button",
        onclick: () => { selectedKey = k; calMonth = new Date(parseKey(k).getFullYear(), parseKey(k).getMonth(), 1); renderMoodForm(); renderCalendar(); $("#mood-form-title").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" }); },
      }, h("span", { class: "ml-emoji", "aria-hidden": "true", text: m.emoji }),
        h("span", { class: "ml-title", text: `${fmtLong(parseKey(k))} · ${m.label}` }),
        h("span", { class: "ml-note", text: e.note || "No journal entry" }))));
    });
  }

  /* =========================================================
     INSIGHTS / CHARTS
     ========================================================= */
  const charts = {};
  let range = "30";
  const inRange = (ts) => range === "all" || ts >= startOfDay(addDays(new Date(), -(Number(range) - 1))).getTime();

  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function rgba(hex, a) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
  }
  function themeColors() {
    return { text: cssVar("--text-2"), strong: cssVar("--text"), grid: cssVar("--border"), accent: cssVar("--accent"), accent2: cssVar("--accent-2"), surface: cssVar("--surface-2") };
  }
  function baseOptions() {
    const t = themeColors();
    return {
      responsive: true, maintainAspectRatio: false,
      animation: reduceMotion() ? false : { duration: 700 },
      layout: { padding: 8 },
      plugins: {
        legend: { display: false, labels: { color: t.text } },
        tooltip: { backgroundColor: t.surface, titleColor: t.strong, bodyColor: t.text, borderColor: t.grid, borderWidth: 1, padding: 10 },
      },
      scales: {
        x: { ticks: { color: t.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 }, grid: { display: false }, border: { color: t.grid } },
        y: { ticks: { color: t.text }, grid: { color: t.grid }, border: { color: t.grid } },
      },
    };
  }
  function mountChart(key, canvasId, hasData, emptyMsg, makeConfig) {
    const canvas = document.getElementById(canvasId);
    const card = canvas.closest(".chart-card");
    const wrap = $(".chart-wrap", card), empty = $(".chart-empty", card);
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    wrap.hidden = !hasData;
    empty.hidden = hasData;
    if (!hasData) { empty.textContent = emptyMsg; return; }
    if (typeof Chart === "undefined") { wrap.hidden = true; empty.hidden = false; empty.textContent = "Charts couldn't load (check your connection and reload)."; return; }
    charts[key] = new Chart(canvas, makeConfig());
  }

  function weekStart(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function pearson(xs, ys) {
    const n = xs.length, mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
  }

  function renderCharts() {
    const t = themeColors();
    const scores = data.assessments.filter((a) => inRange(a.ts));
    const moodKeys = Object.keys(data.moods).filter((k) => inRange(parseKey(k).getTime())).sort();

    // 1. Predicted score history
    mountChart("scores", "chart-scores", scores.length > 0, "No assessments in this period yet. Take an assessment to see your score history.", () => {
      const o = baseOptions();
      o.scales.y.min = SCORE_MIN; o.scales.y.max = SCORE_MAX;
      o.scales.y.title = { display: true, text: "Predicted score", color: t.text };
      o.plugins.tooltip.callbacks = { label: (c) => ` Score: ${c.parsed.y.toFixed(2)}` };
      return { type: "line", data: { labels: scores.map((a) => fmtDateTime(a.ts)), datasets: [{ label: "Predicted score", data: scores.map((a) => a.score), borderColor: t.accent, backgroundColor: rgba(t.accent, 0.14), fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: t.accent }] }, options: o };
    });

    // 2. Mood trend
    mountChart("mood", "chart-mood", moodKeys.length > 0, "No check-ins in this period yet.", () => {
      const o = baseOptions();
      o.scales.y.min = 1; o.scales.y.max = 5;
      o.scales.y.ticks = { color: t.text, stepSize: 1, callback: (v) => (moodByValue(v) ? moodByValue(v).label : "") };
      o.plugins.tooltip.callbacks = { label: (c) => ` Mood: ${moodByValue(c.parsed.y).label}` };
      return { type: "line", data: { labels: moodKeys.map((k) => fmtShort(parseKey(k))), datasets: [{ label: "Mood", data: moodKeys.map((k) => data.moods[k].mood), borderColor: t.accent2, backgroundColor: rgba(t.accent2, 0.14), fill: true, tension: 0.25, pointRadius: 5, pointBackgroundColor: t.accent2 }] }, options: o };
    });

    // 3. Mood distribution
    const counts = MOODS.map((m) => moodKeys.filter((k) => data.moods[k].mood === m.v).length);
    mountChart("dist", "chart-dist", moodKeys.length > 0, "No check-ins in this period yet.", () => {
      const o = baseOptions();
      o.scales.y.ticks = { color: t.text, precision: 0, stepSize: 1 };
      o.scales.y.beginAtZero = true;
      o.plugins.tooltip.callbacks = { label: (c) => ` ${c.parsed.y} ${c.parsed.y === 1 ? "check-in" : "check-ins"}` };
      return { type: "bar", data: { labels: MOODS.map((m) => m.label), datasets: [{ label: "Check-ins", data: counts, backgroundColor: rgba(t.accent2, 0.55), borderColor: t.accent2, borderWidth: 1, borderRadius: 6 }] }, options: o };
    });

    // 4. Consistency (daily for 7 days, otherwise weekly)
    const daily = range === "7";
    $("#consistency-sub").textContent = daily ? "Check-ins and assessments per day." : "Check-ins and assessments per week (weeks start Monday).";
    const checkinTs = Object.keys(data.moods).map((k) => parseKey(k).getTime());
    const assessTs = data.assessments.map((a) => a.ts);
    const allTs = [...checkinTs, ...assessTs].filter(inRange);
    mountChart("consistency", "chart-consistency", allTs.length > 0, "No activity in this period yet.", () => {
      let buckets = [];
      const today = startOfDay(new Date());
      if (daily) {
        for (let i = 6; i >= 0; i--) buckets.push(addDays(today, -i));
      } else {
        const first = weekStart(new Date(Math.min(...allTs)));
        const cur = weekStart(today);
        for (let d = new Date(first); d <= cur; d = addDays(d, 7)) buckets.push(new Date(d));
        if (buckets.length > 26) buckets = buckets.slice(-26);
      }
      const step = daily ? 1 : 7;
      const count = (arr, b) => arr.filter((ts) => ts >= b.getTime() && ts < addDays(b, step).getTime() && inRange(ts)).length;
      const o = baseOptions();
      o.plugins.legend.display = true;
      o.scales.y.ticks = { color: t.text, precision: 0, stepSize: 1 };
      o.scales.y.beginAtZero = true;
      return { type: "bar", data: { labels: buckets.map((b) => (daily ? b.toLocaleDateString(undefined, { weekday: "short" }) : fmtShort(b))), datasets: [
        { label: "Check-ins", data: buckets.map((b) => count(checkinTs, b)), backgroundColor: rgba(t.accent2, 0.55), borderColor: t.accent2, borderWidth: 1, borderRadius: 4 },
        { label: "Assessments", data: buckets.map((b) => count(assessTs, b)), backgroundColor: rgba(t.accent, 0.55), borderColor: t.accent, borderWidth: 1, borderRadius: 4 },
      ] }, options: o };
    });

    // 5. Input vs. predicted score (only when enough data supports it)
    const xKey = $("#corr-x").value;
    const pts = scores.filter((a) => a.inputs && typeof a.inputs[xKey] === "number" && isFinite(a.inputs[xKey]));
    const enough = pts.length >= 5;
    const note = $("#corr-note");
    if (enough) {
      const r = pearson(pts.map((a) => a.inputs[xKey]), pts.map((a) => a.score));
      note.textContent = r === null
        ? `Across ${pts.length} assessments this input didn't vary, so no relationship can be measured.`
        : `Pearson r = ${r.toFixed(2)} across ${pts.length} of your assessments. This only describes how the values moved together in your own entries — it doesn't show that one causes the other, and few data points are unreliable.`;
    } else note.textContent = "This chart appears once you have at least 5 assessments in the selected period.";
    mountChart("corr", "chart-corr", enough, `You have ${pts.length} assessment${pts.length === 1 ? "" : "s"} in this period. At least 5 are needed to show a relationship.`, () => {
      const o = baseOptions();
      o.scales.x = { type: "linear", title: { display: true, text: INPUT_LABELS[xKey], color: t.text }, ticks: { color: t.text }, grid: { color: t.grid }, border: { color: t.grid } };
      o.scales.y.min = SCORE_MIN; o.scales.y.max = SCORE_MAX;
      o.scales.y.title = { display: true, text: "Predicted score", color: t.text };
      o.plugins.tooltip.callbacks = { label: (c) => ` ${INPUT_LABELS[xKey]}: ${c.parsed.x} · Score: ${c.parsed.y.toFixed(2)}` };
      return { type: "scatter", data: { datasets: [{ label: "Assessments", data: pts.map((a) => ({ x: a.inputs[xKey], y: a.score })), backgroundColor: rgba(t.accent, 0.75), borderColor: t.accent, pointRadius: 5 }] }, options: o };
    });
  }

  $$("#range-group .seg-btn").forEach((b) => b.addEventListener("click", () => {
    range = b.dataset.range;
    $$("#range-group .seg-btn").forEach((x) => { const on = x === b; x.classList.toggle("active", on); x.setAttribute("aria-pressed", String(on)); });
    renderCharts();
  }));
  $("#corr-x").addEventListener("change", renderCharts);

  /* =========================================================
     MILESTONES
     ========================================================= */
  function renderMilestones() {
    const s = stats();
    $("#streak-current").textContent = String(s.current);
    $("#streak-sub").textContent = s.best
      ? `Longest streak: ${s.best} ${s.best === 1 ? "day" : "days"}. Missing a day is okay — your best streak and badges stay.`
      : "A streak begins with a single check-in.";
    const targets = [3, 7, 14, 30, 60];
    const next = targets.find((n) => s.current < n);
    const label = $("#streak-next-label"), val = $("#streak-next-val");
    const pct = next ? Math.round((s.current / next) * 100) : 100;
    label.textContent = next ? `Next streak milestone: ${next} days` : "All streak milestones reached";
    val.textContent = next ? `${s.current} / ${next}` : "Nice work";
    $("#streak-fill").style.width = `${pct}%`;
    $("#streak-bar").setAttribute("aria-valuenow", String(pct));

    const grid = $("#badge-grid");
    grid.replaceChildren();
    BADGES.forEach((b) => {
      const earned = data.badges[b.id];
      const t = b.test(s);
      const unlocked = !!earned;
      grid.append(h("article", { class: `card badge-card ${unlocked ? "unlocked" : "locked"}${justUnlocked.has(b.id) ? " just-unlocked" : ""}` },
        h("div", { class: "badge-icon" }, icon(b.icon)),
        h("h4", { text: b.name }),
        h("p", { text: b.desc }),
        unlocked
          ? h("p", { class: "badge-status" }, icon("check"), `Unlocked ${new Date(earned).toLocaleDateString()}`)
          : h("div", {},
              h("div", { class: "progress", role: "progressbar", "aria-label": `${b.name} progress`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(t.pct * 100)) }, h("span", { style: `width:${Math.round(t.pct * 100)}%` })),
              h("p", { class: "badge-status muted" }, icon("lock"), `Locked · ${t.label}`))));
    });
    justUnlocked = new Set();
  }

  /* =========================================================
     WELLNESS ZONE: breathing
     ========================================================= */
  const BREATH_PATTERNS = {
    box: { name: "Box breathing", phases: [["Inhale", 4], ["Hold", 4], ["Exhale", 4], ["Hold", 4]] },
    gentle: { name: "Gentle breathing", phases: [["Inhale", 4], ["Exhale", 6]] },
  };
  const bCircle = $("#breath-circle");
  const bLabel = $("#breath-label");
  const bCount = $("#breath-count");
  const bRemaining = $("#breath-remaining");
  const bStatus = $("#breath-status");
  const bBtns = { start: $("#breath-start"), pause: $("#breath-pause"), resume: $("#breath-resume"), stop: $("#breath-stop") };
  const bSelects = [$("#breath-pattern"), $("#breath-duration")];
  const breath = { timer: null, state: "idle", phases: [], total: 0, elapsed: 0, idx: 0, phaseElapsed: 0, last: 0, cycles: 0, name: "" };
  const BREATH_SCALE = 1.5;

  function breathControls() {
    const s = breath.state;
    bBtns.start.hidden = !(s === "idle" || s === "done");
    bBtns.pause.hidden = s !== "running";
    bBtns.resume.hidden = s !== "paused";
    bBtns.stop.hidden = !(s === "running" || s === "paused");
    bSelects.forEach((sel) => (sel.disabled = s === "running" || s === "paused"));
  }
  function breathVisual(idx, remaining) {
    const name = breath.phases[idx][0];
    if (name === "Hold") return;
    const target = name === "Inhale" ? BREATH_SCALE : 1;
    bCircle.style.transition = reduceMotion() ? "none" : `transform ${Math.max(remaining, 0.05)}s cubic-bezier(.45,.05,.55,.95)`;
    void bCircle.offsetWidth;
    bCircle.style.transform = `scale(${target})`;
  }
  function breathSetPhase(idx) {
    const [name, dur] = breath.phases[idx];
    bLabel.textContent = name;
    bCount.textContent = String(dur);
    breathVisual(idx, dur);
  }
  function breathTick() {
    const now = performance.now();
    const dt = Math.min((now - breath.last) / 1000, 1);
    breath.last = now;
    breath.elapsed += dt;
    breath.phaseElapsed += dt;
    const [, dur] = breath.phases[breath.idx];
    if (breath.phaseElapsed >= dur) {
      breath.phaseElapsed -= dur;
      breath.idx = (breath.idx + 1) % breath.phases.length;
      if (breath.idx === 0) breath.cycles++;
      breathSetPhase(breath.idx);
    }
    bCount.textContent = String(Math.max(1, Math.ceil(breath.phases[breath.idx][1] - breath.phaseElapsed)));
    bRemaining.textContent = fmtClock(breath.total - breath.elapsed);
    if (breath.elapsed >= breath.total) breathComplete();
  }
  function breathClear() { clearInterval(breath.timer); breath.timer = null; }
  function breathStart() {
    const pattern = BREATH_PATTERNS[$("#breath-pattern").value] || BREATH_PATTERNS.box;
    breath.phases = pattern.phases; breath.name = pattern.name;
    breath.total = (Number($("#breath-duration").value) || 2) * 60;
    breath.elapsed = 0; breath.idx = 0; breath.phaseElapsed = 0; breath.cycles = 0;
    breath.state = "running";
    $("#breath-summary").hidden = true;
    bCircle.style.transition = "none"; bCircle.style.transform = "scale(1)"; void bCircle.offsetWidth;
    breathSetPhase(0);
    bRemaining.textContent = fmtClock(breath.total);
    breath.last = performance.now();
    breathClear();
    breath.timer = setInterval(breathTick, 100);
    bStatus.textContent = `${pattern.name} started.`;
    breathControls();
  }
  function breathPause(reason) {
    if (breath.state !== "running") return;
    breathClear();
    breath.state = "paused";
    const tf = getComputedStyle(bCircle).transform; // freeze the circle where it is
    bCircle.style.transition = "none";
    bCircle.style.transform = tf === "none" ? "scale(1)" : tf;
    bLabel.textContent = "Paused";
    bStatus.textContent = reason === "hidden" ? "Paused because the tab was hidden." : "Paused.";
    breathControls();
  }
  function breathResume() {
    if (breath.state !== "paused") return;
    breath.state = "running";
    breath.last = performance.now();
    const [name, dur] = breath.phases[breath.idx];
    bLabel.textContent = name;
    breathVisual(breath.idx, dur - breath.phaseElapsed);
    breath.timer = setInterval(breathTick, 100);
    bStatus.textContent = "Resumed.";
    breathControls();
  }
  function breathStop() {
    breathClear();
    breath.state = "idle";
    bCircle.style.transition = reduceMotion() ? "none" : "transform .5s ease";
    bCircle.style.transform = "scale(1)";
    bLabel.textContent = "Ready"; bCount.textContent = "—";
    bRemaining.textContent = fmtClock((Number($("#breath-duration").value) || 2) * 60);
    bStatus.textContent = "Stopped.";
    breathControls();
  }
  function breathComplete() {
    breathClear();
    breath.state = "done";
    bCircle.style.transition = reduceMotion() ? "none" : "transform .6s ease";
    bCircle.style.transform = "scale(1)";
    bLabel.textContent = "Well done"; bCount.textContent = "✓";
    bRemaining.textContent = "0:00";
    const mins = Math.round(breath.total / 60);
    const msg = `Session complete: ${mins} ${mins === 1 ? "minute" : "minutes"} of ${breath.name.toLowerCase()}, ${breath.cycles} full ${breath.cycles === 1 ? "cycle" : "cycles"}. Notice how you feel right now.`;
    const box = $("#breath-summary");
    box.textContent = msg; box.hidden = false;
    bStatus.textContent = msg;
    breathControls();
    toast("Breathing session complete.", "success");
    logActivity("breathing", breath.total);
  }
  bBtns.start.addEventListener("click", breathStart);
  bBtns.pause.addEventListener("click", () => breathPause());
  bBtns.resume.addEventListener("click", breathResume);
  bBtns.stop.addEventListener("click", breathStop);
  $("#breath-duration").addEventListener("change", () => { if (breath.state === "idle" || breath.state === "done") bRemaining.textContent = fmtClock(Number($("#breath-duration").value) * 60); });

  /* =========================================================
     WELLNESS ZONE: grounding
     ========================================================= */
  const GROUNDING = [
    { n: 5, sense: "See", prompt: "Name 5 things you can see.", hint: "Look slowly around you. Notice colours, shapes or small details." },
    { n: 4, sense: "Touch", prompt: "Notice 4 things you can feel.", hint: "Your feet on the floor, your clothes, the chair, the air on your skin." },
    { n: 3, sense: "Hear", prompt: "Listen for 3 things you can hear.", hint: "Near or far — a fan, voices, birds, your own breathing." },
    { n: 2, sense: "Smell", prompt: "Notice 2 things you can smell.", hint: "If nothing stands out, recall a scent you enjoy." },
    { n: 1, sense: "Taste", prompt: "Notice 1 thing you can taste.", hint: "Perhaps a sip of water, or simply the inside of your mouth." },
  ];
  let groundIdx = 0;
  let groundDone = false;
  const gPrev = $("#ground-prev"), gNext = $("#ground-next");
  function renderGrounding() {
    const dots = $("#ground-dots");
    dots.replaceChildren();
    GROUNDING.forEach((_, i) => dots.append(h("li", { class: i < groundIdx || groundDone ? "done" : "", "aria-current": i === groundIdx && !groundDone ? "step" : null })));
    if (groundDone) {
      $("#ground-step-label").textContent = "Complete";
      $("#ground-number").textContent = "✓";
      $("#ground-prompt").textContent = "Well done. Take a slow breath.";
      $("#ground-hint").textContent = "You can repeat this any time you'd like to feel more present.";
      gNext.replaceChildren(icon("rotate"), h("span", { text: "Start again" }));
      gPrev.disabled = false;
      return;
    }
    const s = GROUNDING[groundIdx];
    $("#ground-step-label").textContent = `Step ${groundIdx + 1} of ${GROUNDING.length} · ${s.sense}`;
    $("#ground-number").textContent = String(s.n);
    $("#ground-prompt").textContent = s.prompt;
    $("#ground-hint").textContent = s.hint;
    gPrev.disabled = groundIdx === 0;
    const last = groundIdx === GROUNDING.length - 1;
    gNext.replaceChildren(h("span", { text: last ? "Finish" : "Next" }), icon(last ? "check" : "chev-r"));
  }
  gPrev.addEventListener("click", () => {
    if (groundDone) { groundDone = false; groundIdx = GROUNDING.length - 1; }
    else if (groundIdx > 0) groundIdx--;
    renderGrounding();
  });
  gNext.addEventListener("click", () => {
    if (groundDone) { groundDone = false; groundIdx = 0; renderGrounding(); return; }
    if (groundIdx < GROUNDING.length - 1) { groundIdx++; renderGrounding(); return; }
    groundDone = true;
    renderGrounding();
    toast("Grounding exercise complete.", "success");
    logActivity("grounding", 0);
  });

  /* =========================================================
     WELLNESS ZONE: mindfulness timer
     ========================================================= */
  const tState = { timer: null, state: "idle", total: 300, remaining: 300, last: 0 };
  const tDisplay = $("#timer-display"), tFill = $("#timer-fill"), tBar = $("#timer-bar");
  const tStart = $("#timer-start"), tReset = $("#timer-reset"), tMinutes = $("#timer-minutes"), tStatus = $("#timer-status");

  function timerRender() {
    tDisplay.textContent = fmtClock(tState.remaining);
    const pct = tState.total ? Math.round(((tState.total - tState.remaining) / tState.total) * 100) : 0;
    tFill.style.width = `${pct}%`;
    tBar.setAttribute("aria-valuenow", String(pct));
    const label = { idle: "Start", running: "Pause", paused: "Resume", done: "Start again" }[tState.state];
    tStart.replaceChildren(icon(tState.state === "running" ? "pause" : "play"), h("span", { text: label }));
  }
  function timerMinutes() { return Math.min(120, Math.max(1, Math.round(Number(tMinutes.value) || 5))); }
  function timerSetMinutes(min) {
    tState.total = min * 60; tState.remaining = tState.total; tState.state = "idle";
    clearInterval(tState.timer); tState.timer = null;
    tMinutes.value = String(min);
    $$(".chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.min) === min));
    timerRender();
  }
  function timerTick() {
    const now = performance.now();
    tState.remaining -= Math.min((now - tState.last) / 1000, 1);
    tState.last = now;
    if (tState.remaining <= 0) { timerComplete(); return; }
    timerRender();
  }
  function timerComplete() {
    clearInterval(tState.timer); tState.timer = null;
    tState.remaining = 0; tState.state = "done";
    timerRender();
    tStatus.textContent = "Timer finished.";
    toast("Mindfulness timer finished.", "success");
    if ($("#timer-chime").checked) chime();
    logActivity("timer", tState.total);
  }
  function chime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [523.25, 659.25, 783.99].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine"; o.frequency.value = f;
        const t0 = ctx.currentTime + i * 0.35;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
        o.connect(g).connect(ctx.destination);
        o.start(t0); o.stop(t0 + 1.7);
      });
      setTimeout(() => ctx.close(), 3000);
    } catch (e) { /* audio unavailable */ }
  }
  tStart.addEventListener("click", () => {
    if (tState.state === "idle" || tState.state === "done") {
      tState.total = timerMinutes() * 60; tState.remaining = tState.total; tState.state = "running";
      tState.last = performance.now(); clearInterval(tState.timer); tState.timer = setInterval(timerTick, 250);
      tStatus.textContent = "Timer started.";
    } else if (tState.state === "running") {
      clearInterval(tState.timer); tState.timer = null; tState.state = "paused"; tStatus.textContent = "Paused.";
    } else if (tState.state === "paused") {
      tState.state = "running"; tState.last = performance.now(); tState.timer = setInterval(timerTick, 250); tStatus.textContent = "Resumed.";
    }
    timerRender();
  });
  tReset.addEventListener("click", () => { timerSetMinutes(timerMinutes()); tStatus.textContent = "Timer reset."; });
  tMinutes.addEventListener("change", () => timerSetMinutes(timerMinutes()));
  $$(".chip").forEach((c) => c.addEventListener("click", () => timerSetMinutes(Number(c.dataset.min))));

  // Pause running exercises if the tab is hidden; refresh date-dependent UI when returning
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      breathPause("hidden");
      if (tState.state === "running") { clearInterval(tState.timer); tState.timer = null; tState.state = "paused"; timerRender(); }
    } else if (dateKey() !== renderedDay) {
      selectedKey = dateKey();
      calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      renderAll();
    }
  });
  window.addEventListener("pagehide", () => { breathClear(); clearInterval(tState.timer); });

  /* =========================================================
     PDF REPORT
     ========================================================= */
  function openReport() { openDialog($("#report-dialog")); }

  function generateReport(opts) {
    const J = window.jspdf && window.jspdf.jsPDF;
    if (!J) { toast("The PDF library couldn't load (check your connection). As a fallback, use your browser's Print → Save as PDF.", "error", 6500); return false; }
    if (!data.assessments.length && !Object.keys(data.moods).length) {
      toast("There's nothing to include yet. Complete an assessment or a mood check-in first.", "info", 5000);
      return false;
    }
    const doc = new J({ unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 48;
    let y = M;
    const clean = (s) => String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/[^\n\x20-\x7E\u00A0-\u00FF]/g, "");
    const ensure = (n) => { if (y + n > H - M) { doc.addPage(); y = M; } };
    const heading = (t) => {
      ensure(40); y += 12;
      doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 122, 76);
      doc.text(clean(t), M, y); y += 6;
      doc.setDrawColor(205); doc.line(M, y, W - M, y); y += 16;
    };
    const para = (t, o = {}) => {
      const size = o.size || 10;
      doc.setFont("helvetica", o.bold ? "bold" : "normal"); doc.setFontSize(size);
      doc.setTextColor(...(o.color || [45, 45, 45]));
      doc.splitTextToSize(clean(t), W - 2 * M - (o.indent || 0)).forEach((l) => { ensure(size + 4); doc.text(l, M + (o.indent || 0), y); y += size + 4; });
      y += o.gap === undefined ? 4 : o.gap;
    };

    const now = new Date();
    const latest = data.assessments.at(-1);

    // Title
    doc.setFont("helvetica", "bold"); doc.setFontSize(21); doc.setTextColor(17, 32, 24);
    doc.text("Mansik Santulan - Wellness Report", M, y); y += 22;
    para(`Generated ${now.toLocaleString()}`, { size: 10, color: [100, 100, 100], gap: 8 });
    para("This report is a machine-learning wellness estimate with self-reported entries. It is not a clinical assessment or diagnosis and should not replace professional advice.", { size: 9.5, color: [90, 90, 90], gap: 6 });

    // Latest assessment
    heading("Latest assessment");
    if (latest) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(17, 32, 24);
      ensure(34); doc.text(`${latest.score.toFixed(2)} / ${SCORE_MAX}`, M, y); y += 20;
      para(`Recorded ${new Date(latest.ts).toLocaleString()}. Scale shown by the application: ${SCORE_MIN}-${SCORE_MAX} (what higher or lower means should be confirmed against the model documentation).`, { color: [90, 90, 90] });
      para("Answers submitted:", { bold: true, gap: 2 });
      Object.keys(INPUT_LABELS).forEach((k) => { if (latest.inputs && latest.inputs[k] !== undefined) para(`${INPUT_LABELS[k]}: ${latest.inputs[k]}`, { indent: 10, gap: 0 }); });
      y += 6;
    } else para("No assessments recorded yet.");

    // Previous scores + progress
    heading("Score history");
    if (data.assessments.length) {
      const list = data.assessments.slice(-10).reverse();
      list.forEach((a) => para(`${new Date(a.ts).toLocaleDateString()}  -  ${a.score.toFixed(2)} / ${SCORE_MAX}`, { gap: 0 }));
      y += 6;
      const scoresAll = data.assessments.map((a) => a.score);
      para(`${scoresAll.length} assessment${scoresAll.length === 1 ? "" : "s"} recorded. Average: ${mean(scoresAll).toFixed(2)}. Lowest: ${Math.min(...scoresAll).toFixed(2)}. Highest: ${Math.max(...scoresAll).toFixed(2)}.`);
      if (scoresAll.length >= 2) {
        const pts = data.assessments.slice(-20);
        const cw = W - 2 * M - 30, ch = 110;
        ensure(ch + 36);
        const x0 = M + 30, y0 = y + 8;
        doc.setDrawColor(220); doc.setLineWidth(0.5);
        [0, 5, 10].forEach((v) => {
          const yy = y0 + ch - (v / SCORE_MAX) * ch;
          doc.line(x0, yy, x0 + cw, yy);
          doc.setFontSize(8); doc.setTextColor(120); doc.text(String(v), M + 14, yy + 3);
        });
        doc.setDrawColor(30, 122, 76); doc.setLineWidth(1.5); doc.setFillColor(30, 122, 76);
        const px = (i) => x0 + (pts.length === 1 ? cw / 2 : (i / (pts.length - 1)) * cw);
        const py = (s) => y0 + ch - (Math.max(SCORE_MIN, Math.min(SCORE_MAX, s)) / SCORE_MAX) * ch;
        pts.forEach((p, i) => { if (i) doc.line(px(i - 1), py(pts[i - 1].score), px(i), py(p.score)); });
        pts.forEach((p, i) => doc.circle(px(i), py(p.score), 2.2, "F"));
        doc.setFontSize(8); doc.setTextColor(120);
        doc.text(new Date(pts[0].ts).toLocaleDateString(), x0, y0 + ch + 14);
        doc.text(new Date(pts.at(-1).ts).toLocaleDateString(), x0 + cw, y0 + ch + 14, { align: "right" });
        y += ch + 28;
      }
    } else para("No assessments recorded yet.");

    // Mood summary (opt-in)
    const moodKeys = Object.keys(data.moods).sort();
    if (opts.includeMood) {
      heading("Mood summary");
      if (moodKeys.length) {
        const s = computeStreaks();
        para(`${moodKeys.length} check-in${moodKeys.length === 1 ? "" : "s"} recorded. Current streak: ${s.current} day${s.current === 1 ? "" : "s"}. Longest streak: ${s.best} day${s.best === 1 ? "" : "s"}.`);
        const cutoff = dateKey(addDays(new Date(), -29));
        const recent = moodKeys.filter((k) => k >= cutoff);
        if (recent.length) {
          para(`Last 30 days: ${recent.length} check-in${recent.length === 1 ? "" : "s"}, average mood ${mean(recent.map((k) => data.moods[k].mood)).toFixed(1)} on a 1-5 scale.`, { gap: 2 });
          MOODS.forEach((m) => para(`${m.label}: ${recent.filter((k) => data.moods[k].mood === m.v).length}`, { indent: 10, gap: 0 }));
          y += 6;
        }
        para("Most recent entries:", { bold: true, gap: 2 });
        moodKeys.slice(-10).reverse().forEach((k) => {
          const e = data.moods[k];
          para(`${parseKey(k).toLocaleDateString()}  -  ${moodByValue(e.mood).label}`, { indent: 10, gap: opts.includeJournal && e.note ? 1 : 0 });
          if (opts.includeJournal && e.note) para(`"${e.note}"`, { indent: 24, size: 9, color: [90, 90, 90], gap: 3 });
        });
        if (opts.includeJournal) para("Journal text is included because you chose to include it. Non-Latin characters and emoji can't be shown in this PDF and are omitted.", { size: 8.5, color: [120, 120, 120] });
      } else para("No mood check-ins recorded yet.");
    }

    // Self-care
    if (data.activities.length) {
      heading("Self-care sessions");
      const by = {}; data.activities.forEach((a) => { by[a.type] = (by[a.type] || 0) + 1; });
      para(Object.entries(by).map(([k, v]) => `${k}: ${v}`).join("   |   "));
    }

    // Suggestions
    heading("General wellness suggestions");
    const recs = latest ? buildRecommendations(latest.inputs) : [];
    if (recs.length) recs.forEach((r) => { para(r.title, { bold: true, gap: 1 }); para(r.text, { gap: 1 }); para(`Based on: ${r.basis}`, { size: 9, color: [110, 110, 110], gap: 6 }); });
    else para(latest ? "Your answers don't trigger any specific suggestions. Regular check-ins can help you notice patterns over time." : "Complete an assessment to see suggestions based on your answers.");
    para("These are simple rule-based suggestions, not model explanations and not medical advice.", { size: 9, color: [110, 110, 110] });

    // Limitations
    heading("Limitations");
    [
      "The score is a statistical estimate produced by a machine-learning model from 12 self-reported inputs. It cannot diagnose, detect or rule out any condition.",
      "A single score is a snapshot; changes between scores may not be meaningful.",
      "Data in this report comes from this browser's local storage on one device and may be incomplete.",
      "If you are struggling, please talk to someone you trust or a qualified professional. In an emergency, contact local emergency services.",
    ].forEach((t) => para(`- ${t}`, { gap: 3 }));

    // Footer / page numbers
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(140);
      doc.text("Mansik Santulan Score - informational only, not a clinical assessment", M, H - 24);
      doc.text(`Page ${i} of ${n}`, W - M, H - 24, { align: "right" });
    }
    doc.save(`mansik-santulan-report-${dateKey()}.pdf`);
    return true;
  }
  $("#rep-generate").addEventListener("click", () => {
    const ok = generateReport({ includeMood: $("#rep-mood").checked, includeJournal: $("#rep-mood").checked && $("#rep-journal").checked });
    if (ok) { $("#report-dialog").close(); toast("Report downloaded.", "success"); }
  });
  $("#rep-journal").addEventListener("change", (e) => { if (e.target.checked) $("#rep-mood").checked = true; });

  /* =========================================================
     SETTINGS / PRIVACY
     ========================================================= */
  function openSettings() {
    $("#storage-warning").hidden = storageAvailable && storageProbe();
    openDialog($("#settings-dialog"));
  }
  $("#export-data").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `mansik-santulan-data-${dateKey()}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Data exported. The file contains your journal text — keep it private.", "info", 5000);
  });
  $("#clear-data").addEventListener("click", async () => {
    $("#settings-dialog").close();
    const ok = await confirmDialog("Clear all local data?", "This permanently deletes your assessment history, mood entries, journal text, badges and session counts from this browser. It can't be undone.", "Clear data");
    if (!ok) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
    data = defaultData();
    selectedKey = dateKey();
    showState("idle"); $("#result-extra").hidden = true;
    renderAll();
    toast("Local data cleared.", "success");
  });

  /* =========================================================
     RENDER + INIT
     ========================================================= */
  function renderAll() {
    renderDashboard();
    renderMoodForm();
    renderCalendar();
    renderMoodList();
    renderMilestones();
    renderCharts();
  }

  applyTheme(getTheme(), false);
  updateFormProgress();
  renderGrounding();
  timerRender();
  breathControls();
  bRemaining.textContent = fmtClock(Number($("#breath-duration").value) * 60);
  renderAll();
  updateActiveNav();
  checkBadges();
  window.addEventListener("load", () => { moveIndicator(); renderCharts(); });
})();