/*!
 * OrbSniper - renderer
 * (c) 2026 synaps_ss - tg: @synaps_ss
 */

const GITHUB_URL = "https://github.com/syntaxixr/OrbSniper";
const TELEGRAM_URL = "https://t.me/synaps_ss";

const $ = (id) => document.getElementById(id);
const LOG_LIMIT = 400;

let lang = "ru";
let running = false;
let claimed = 0;
let stickToBottom = true;
let tally = { total: 0, done: 0, left: 0, manual: 0 };
let appSettings = {
  launchAtLogin: false, minimizeToTray: false, theme: "dark",
  prioritizeOrbs: true, orbOnly: false, excludedQuestIds: [], questOrder: []
};
let questItems = [];
let currentProgress = null;
let currentProgressAt = 0;

// ---------- i18n ----------
function t(key, ...args) {
  let s = (I18N[lang] && I18N[lang][key]) || I18N.ru[key] || key;
  // split/join instead of replace: paths may contain $& patterns
  args.forEach((v, i) => { s = s.split("{" + i + "}").join(String(v)); });
  return s;
}

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  const cur = LANGS.find((l) => l.code === lang);
  $("lang-cur").textContent = cur ? cur.tag : lang.toUpperCase();
  $("btn-help").title = t("help_title");
  renderLangMenu();
  if (!running) setIdle();
}

function renderLangMenu() {
  const menu = $("lang-menu");
  menu.replaceChildren();
  for (const l of LANGS) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "option";
    b.setAttribute("aria-selected", String(l.code === lang));
    if (l.code === lang) b.className = "on";
    const name = document.createElement("span");
    name.textContent = l.label;
    const code = document.createElement("span");
    code.className = "lm-code";
    code.textContent = l.tag;
    b.append(code, name);
    b.addEventListener("click", () => {
      lang = l.code;
      try { localStorage.setItem("orbsniper.lang", lang); } catch (_) {}
      closeLangMenu();
      applyLang();
    });
    menu.append(b);
  }
}

function closeLangMenu() {
  $("lang-menu").hidden = true;
  $("lang-btn").setAttribute("aria-expanded", "false");
}

// ---------- engine events ----------
// The engine used to log English sentences that this file matched with ~30
// regexes to work out what had happened, then translated back. Anything that
// depended on the wording broke silently in some languages - the claimed
// counter, for one, never moved on German, French, Polish or Turkish.
// Now the engine sends structured events and the text is built from the key.
const EVENTS = {
  // Metadata is forwarded through dedicated preload listeners; these entries
  // also keep the engine-to-UI event contract explicit and testable.
  quests:         ()  => ["l_watching", "info"],
  account:        ()  => ["l_watching", "info"],
  balance:        ()  => ["l_watching", "info"],
  quest_filtered: (e) => ["l_skipped", "warn", e.quest],
  started:       ()  => ["l_watching", "info"],
  takeover:      ()  => ["l_takeover", "info"],
  dup:           ()  => ["l_dup", "warn"],
  accepting:     (e) => ["l_accepting", "info", e.quest],
  accepted:      (e) => ["l_accepted", "ok", e.quest],
  accept_failed: (e) => ["l_acceptfail", "warn", e.quest, e.why],
  captcha:       (e) => [e.at === "accept" ? "l_captcha_accept" : "l_captcha_claim", "warn", e.quest],
  // Only a play/stream task is a game being faked. Saying "pretending to
  // play" while watching a video described the wrong thing entirely.
  quest_start:   (e) => (e.game && /^(PLAY|STREAM)/.test(e.task || "")
                          ? ["l_playing", "info", e.quest, e.game]
                          : ["l_qstart", "info", e.quest]),
  quest_done:    (e) => ["l_completed", "ok", e.quest],
  quest_skipped: (e) => {
    if (e.why === "stalled") return ["l_stalled", "warn", e.quest];
    if (e.why === "unsupported") return ["l_unsupported", "warn", e.quest];
    return ["l_skipped", "warn", e.quest];
  },
  quest_later:   (e) => ["l_later", "warn", e.quest],
  quest_gaveup:  (e) => ["l_gaveup", "err", e.quest, e.tries],
  claiming:      (e) => ["l_claiming", "info", e.quest],
  claimed:       (e) => ["l_claimed", "ok", e.quest],
  claim_blocked: (e) => ["l_claimblocked", "warn", e.quest, e.why],
  claim_retry:   (e) => ["l_claimretry", "warn", e.quest, e.why],
  claim_giveup:  (e) => ["l_claimgiveup", "err", e.quest, e.why],
  unsupported:   (e) => ["l_unsupported", "warn", e.quest],
  idle:          ()  => ["l_noquests", "info"],
  scan_error:    (e) => ["l_scanerror", "err", e.why],
  api_retry:     (e) => ["l_apiretry", "warn", e.quest, e.why],
  modules_failed:()  => ["l_nomodules", "err"],
  api_unusable:  ()  => ["l_noapi", "err"],
  crashed:       (e) => ["l_fatal", "err", e.why],
  stopped:       ()  => ["l_stopped", "info"]
};

function onEngineEvent(e) {
  if (!e || !e.ev) return;

  if (e.ev === "quest_filtered") {
    const reason = e.reason === "no_orbs" ? "has no Orb reward" : "is excluded from your queue";
    pushLine(`Skipped ${e.quest}: ${reason}.`, "warn");
    return;
  }

  if (e.ev === "quest_done") {
    currentProgress = null;
    $("f-remaining").textContent = "0:00";
  }

  if (e.ev === "claimed") {
    claimed++;
    $("f-claimed").textContent = String(claimed);
    $("facts").hidden = false;
  }
  if (e.ev === "idle" || e.ev === "started") {
    $("f-target").textContent = t("f_searching");
    $("f-pct").textContent = "—";
    $("f-time").textContent = "—";
    $("facts").hidden = false;
    $("bar").hidden = true;
  }
  if (e.ev === "modules_failed" || e.ev === "api_unusable" || e.ev === "crashed") {
    setPhase("error");
  }

  const build = EVENTS[e.ev];
  if (!build) return;
  const [key, level, ...args] = build(e);
  pushLine(t(key, ...args.map((a) => (a === undefined || a === null ? "" : a))), level);
}

// ---------- state ----------
function setButtons() {
  $("btn-start").disabled = running;
  $("btn-stop").disabled = !running;
  $("btn-skip").disabled = !running;
}

// The repair button only appears when something actually broke.
function showRepair(show) {
  $("btn-repair").hidden = !show;
  $("btn-repair").disabled = false;
}

function setBeacon(cls) { $("beacon").className = "beacon " + cls; }

function setStatus(title, hint, beacon, stateCls) {
  $("status-text").textContent = title;
  $("status-hint").textContent = hint;
  setBeacon(beacon || "");
  $("status").className = "status" + (stateCls ? " " + stateCls : "");
}

function setIdle() {
  currentProgress = null;
  running = false;
  setStatus(t("st_idle"), t("hint_idle"), "", "");
  $("bar").hidden = true;
  $("facts").hidden = true;
  $("tally").hidden = true;
  setButtons();
}

function setProgress(pct) {
  $("bar").hidden = false;
  $("bar").value = pct;           // attribute, not inline style (keeps CSP strict)
  // The ring uses pathLength="100", so the offset is simply what is left.
  $("ring-val").setAttribute("stroke-dashoffset", String(100 - pct));
}

// ---------- quest summary ----------
function renderTally(data) {
  tally = data || tally;
  const has = tally.total > 0;
  $("tally").hidden = !has;
  if (!has) return;
  $("tl-done").textContent = String(tally.done);
  $("tl-left").textContent = String(tally.left);
  $("tl-manual-n").textContent = String(tally.manual);
  $("tl-manual").hidden = !tally.manual;
}

// ---------- finish screen ----------
function showFinish() {
  $("fin-done").textContent = String(tally.done);
  $("fin-manual").textContent = String(tally.manual);
  $("fin-manual-box").hidden = !tally.manual;
  $("fin-note").hidden = !tally.manual;
  $("finish-lead").textContent = tally.manual ? t("fin_lead_manual") : t("fin_lead");
  $("finish").hidden = false;
}

function closeFinish() {
  const el = $("finish");
  el.classList.add("closing");
  setTimeout(() => { el.hidden = true; el.classList.remove("closing"); }, 240);
}

// ---------- console log ----------
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Last line of defence for the journal. Whatever an engine or Discord hands
// us, a console line stays a console line: no markup, no page-sized dumps.
const LINE_LIMIT = 220;
function tidy(text) {
  let x = String(text);
  if (/<(!doctype|html)[\s>]/i.test(x)) return t("l_errpage");
  if (/<[a-z][^>]*>/i.test(x)) x = x.replace(/<[^>]*>/g, " ");
  x = x.replace(/\s+/g, " ").trim();
  return x.length > LINE_LIMIT ? x.slice(0, LINE_LIMIT) + "…" : x;
}

function pushLine(raw, level) {
  const text = tidy(raw);
  if (!text) return;
  const box = $("log");
  $("cn-body").classList.add("live");

  const last = box.lastElementChild;
  if (last && last.dataset.text === text) {
    const n = (parseInt(last.dataset.count || "1", 10) || 1) + 1;
    last.dataset.count = String(n);
    let badge = last.querySelector(".rep");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rep";
      last.querySelector(".tx").append(badge);
    }
    badge.textContent = "×" + n;
    last.querySelector("time").textContent = nowStamp();
    return;
  }

  const line = document.createElement("div");
  line.className = "line " + (level || "info");
  line.dataset.text = text;
  const time = document.createElement("time");
  time.textContent = nowStamp();
  const tx = document.createElement("span");
  tx.className = "tx";
  tx.textContent = text;
  line.append(time, tx);
  box.append(line);

  while (box.children.length > LOG_LIMIT) box.firstElementChild.remove();

  if (stickToBottom) {
    box.scrollTop = box.scrollHeight;
    $("jump").hidden = true;
  } else {
    $("jump").hidden = false;
  }
}

// Raw launcher diagnostics (WebSocket errors and the like). Everything the user
// is meant to read arrives as an event or a translated key instead.
function addLog(raw) {
  if (!raw) return;
  const s = String(raw).replace(/^\[[!✓i]\]\s*/, "").trim();
  if (!s) return;
  pushLine(s, /^\[!\]/.test(String(raw)) ? "err" : "info");
}

function say(key) { pushLine(t(key), "info"); }

function logText() {
  return [...$("log").children].map((l) => {
    const rep = l.dataset.count && l.dataset.count !== "1" ? ` (x${l.dataset.count})` : "";
    return `${l.querySelector("time").textContent}  ${l.querySelector(".tx").textContent}${rep}`;
  }).join("\n");
}

// ---------- phases ----------
const PHASE_HINT = {
  closing: "hint_closing",
  launching: "hint_launching",
  waiting: "hint_waiting",
  connecting: "hint_connecting",
  farming: "hint_farming"
};

function setPhase(phase) {
  if (phase === "error") {
    running = false;
    setStatus(t("st_err"), t("hint_repair"), "err", "err");
    setButtons();
    showRepair(true);
    return;
  }
  running = true;
  showRepair(false);
  const title = phase === "farming" ? t("st_running") : t("st_starting");
  setStatus(title, t(PHASE_HINT[phase] || "hint_starting"), "run", "");
  setButtons();
}

// ---------- quest queue and appearance ----------
const fmtTime = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
};
const fmtSeconds = (seconds) => fmtTime(Math.max(0, Number(seconds) || 0) * 1000);
const orbCount = (q) => Math.max(0, Number(q && q.orbs) || 0);
const premiumOrbCount = (q) => Math.max(0, Number(q && q.premiumOrbs) || 0);

function applyTheme() {
  document.documentElement.dataset.theme = appSettings.theme === "light" ? "light" : "dark";
}
function syncSettingsControls() {
  $("setting-startup").checked = !!appSettings.launchAtLogin;
  $("setting-tray").checked = !!appSettings.minimizeToTray;
  $("setting-theme").value = appSettings.theme === "light" ? "light" : "dark";
  $("setting-orb-only").checked = !!appSettings.orbOnly;
  $("setting-prioritize").checked = appSettings.prioritizeOrbs !== false;
}
async function persistSettings(patch) {
  appSettings = Object.assign({}, appSettings, patch || {});
  applyTheme();
  syncSettingsControls();
  renderQuestQueue();
  try {
    const saved = await window.sniper.saveSettings(appSettings);
    if (saved) appSettings = Object.assign({}, appSettings, saved);
    applyTheme();
    syncSettingsControls();
    renderQuestQueue();
  } catch (_) {
    toast("Could not save settings.");
  }
}
function orderedQuestItems() {
  const order = new Map((appSettings.questOrder || []).map((id, i) => [String(id), i]));
  return [...questItems].sort((a, b) => {
    const ai = order.has(String(a.id)) ? order.get(String(a.id)) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(String(b.id)) ? order.get(String(b.id)) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    if (appSettings.prioritizeOrbs) {
      const rewardDiff = Math.max(orbCount(b), premiumOrbCount(b)) - Math.max(orbCount(a), premiumOrbCount(a));
      if (rewardDiff) return rewardDiff;
    }
    const ae = Date.parse(a.expiresAt || "") || Number.MAX_SAFE_INTEGER;
    const be = Date.parse(b.expiresAt || "") || Number.MAX_SAFE_INTEGER;
    return ae - be;
  });
}
function renderQuestQueue() {
  const container = $("quest-list");
  if (!container) return;
  container.replaceChildren();
  const ordered = orderedQuestItems();
  if (!ordered.length) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = "No quests received yet. Start OrbSniper and wait for Discord's next quest scan.";
    container.append(empty);
    $("queue-total").textContent = "0 quests selected · 0 Orbs";
    return;
  }

  const excluded = new Set((appSettings.excludedQuestIds || []).map(String));
  let selectedCount = 0;
  let selectedOrbs = 0;
  let selectedPremiumOrbs = 0;

  ordered.forEach((q, index) => {
    const id = String(q.id);
    const reward = orbCount(q);
    const premium = premiumOrbCount(q);
    const allowed = !excluded.has(id);
    const eligible = allowed && (!appSettings.orbOnly || reward > 0 || premium > 0);
    if (eligible) {
      selectedCount++;
      selectedOrbs += reward;
      selectedPremiumOrbs += premium;
    }

    const row = document.createElement("div");
    row.className = "quest-row" + (allowed ? "" : " excluded");

    const include = document.createElement("input");
    include.type = "checkbox";
    include.className = "quest-include";
    include.checked = allowed;
    include.setAttribute("aria-label", `Include ${q.name} in the quest queue`);
    include.addEventListener("change", () => {
      const next = new Set((appSettings.excludedQuestIds || []).map(String));
      if (include.checked) next.delete(id); else next.add(id);
      persistSettings({ excludedQuestIds: [...next] });
    });

    const info = document.createElement("div");
    info.className = "quest-info";
    const title = document.createElement("div");
    title.className = "quest-title";
    title.textContent = q.name || "Discord Quest";
    const details = document.createElement("div");
    details.className = "quest-sub";
    const duration = q.target ? fmtSeconds(q.target) : "duration unknown";
    const game = q.game || "Discord";
    const task = String(q.task || "task").replace(/_/g, " ").toLowerCase();
    details.textContent = `${game} · ${task} · ${duration}`;
    info.append(title, details);

    const rewardEl = document.createElement("div");
    rewardEl.className = "quest-reward" + (reward + premium > 0 ? "" : " no-orbs");
    rewardEl.textContent = reward + premium > 0
      ? `${reward.toLocaleString()} Orbs${premium ? ` + ${premium.toLocaleString()} Premium` : ""}`
      : "No Orb reward";

    const status = document.createElement("div");
    status.className = "quest-status";
    status.textContent = q.status || "available";

    const actions = document.createElement("div");
    actions.className = "quest-actions";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "queue-move";
    up.textContent = "↑";
    up.title = "Move earlier";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveQuest(id, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "queue-move";
    down.textContent = "↓";
    down.title = "Move later";
    down.disabled = index === ordered.length - 1;
    down.addEventListener("click", () => moveQuest(id, 1));
    actions.append(up, down);

    row.append(include, info, rewardEl, status, actions);
    container.append(row);
  });

  const premiumText = selectedPremiumOrbs ? ` · + ${selectedPremiumOrbs.toLocaleString()} Premium Orbs` : "";
  $("queue-total").textContent =
    `${selectedCount} quests selected · ${selectedOrbs.toLocaleString()} Orbs${premiumText}`;
}
function moveQuest(id, delta) {
  const ordered = orderedQuestItems().map(q => String(q.id));
  const from = ordered.indexOf(String(id));
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ordered.length) return;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  persistSettings({ questOrder: ordered });
}

// ---------- current quest ----------
function tickProgress() {
  if (!currentProgress) return;
  const p = currentProgress;
  const elapsed = Math.max(0, Number(p.elapsed) || 0) + Math.max(0, Date.now() - currentProgressAt);
  const done = Math.max(0, Number(p.done) || 0);
  const need = Math.max(0, Number(p.need) || 0);
  const elapsedSinceStart = Math.max(0, elapsed - (p.baseElapsed || 0)) / 1000;
  const progressSinceStart = Math.max(0, done - (p.baseDone || 0));
  const rate = elapsedSinceStart >= 3 && progressSinceStart > 0
    ? Math.max(0.1, Math.min(3, progressSinceStart / elapsedSinceStart))
    : 1;
  const remaining = need > done ? (need - done) / rate : 0;
  $("f-time").textContent = fmtTime(elapsed);
  $("f-remaining").textContent = need ? fmtSeconds(remaining) : "—";
}
function updateQuest(p) {
  if (!p || !p.quest) return;
  if (!currentProgress || currentProgress.quest !== p.quest) {
    currentProgress = { ...p, baseDone: Number(p.done) || 0, baseElapsed: Number(p.elapsed) || 0 };
  } else {
    currentProgress = { ...currentProgress, ...p };
  }
  currentProgressAt = Date.now();

  const pct = p.need > 0 ? Math.min(100, Math.round((p.done / p.need) * 100)) : 0;
  setProgress(pct);
  $("facts").hidden = false;
  $("f-target").textContent = p.quest;
  $("f-pct").textContent = pct + "%";
  const task = String(p.task || "").replace(/_/g, " ").toLowerCase();
  $("f-meta").textContent = [p.game, task].filter(Boolean).join(" · ") || "Discord Quest";
  tickProgress();
  $("status-text").textContent = t("st_running");
  $("status-hint").textContent = t("hint_quest", p.quest);
}

// ---------- toast & modals ----------
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

let openModal = null;
function showModal(id) {
  closeModal();
  openModal = $(id);
  openModal.hidden = false;
  $("scrim").hidden = false;
  openModal.setAttribute("tabindex", "-1");
  openModal.focus();
}
function closeModal() {
  if (openModal) openModal.hidden = true;
  openModal = null;
  $("scrim").hidden = true;
}

function flash(btn, labelEl, key) {
  labelEl.textContent = t("copied");
  btn.classList.add("done");
  setTimeout(() => {
    labelEl.textContent = t(key);
    btn.classList.remove("done");
  }, 1600);
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  try {
    const saved = localStorage.getItem("orbsniper.lang");
    if (saved && I18N[saved]) lang = saved;
    else {
      const nav = (navigator.language || "ru").slice(0, 2).toLowerCase();
      if (I18N[nav]) lang = nav;
    }
  } catch (_) {}

  applyLang();
  setIdle();
  applyTheme();
  window.sniper.getSettings().then((saved) => {
    if (saved) appSettings = Object.assign({}, appSettings, saved);
    applyTheme();
    syncSettingsControls();
    renderQuestQueue();
  }).catch(() => {});
  setInterval(tickProgress, 1000);

  window.sniper.getVersion().then((v) => { if (v) $("tb-ver").textContent = "v" + v; }).catch(() => {});

  $("btn-min").addEventListener("click", () => window.sniper.minimize());
  $("btn-close").addEventListener("click", () => window.sniper.close());

  $("lang-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("lang-menu");
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    $("lang-btn").setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (e) => {
    if (!$("lang-wrap").contains(e.target)) closeLangMenu();
  });

  const beginRun = () => {
    currentProgress = null;
    running = true;
    claimed = 0;
    tally = { total: 0, done: 0, left: 0, manual: 0 };
    $("tally").hidden = true;
    $("finish").hidden = true;
    $("f-claimed").textContent = "0";
    showRepair(false);
    setButtons();
  };

  $("btn-start").addEventListener("click", () => {
    beginRun();
    setStatus(t("st_starting"), t("hint_starting"), "run", "");
    say("l_begin");
    window.sniper.start();
  });

  $("btn-stop").addEventListener("click", async () => {
    await window.sniper.stop();
    setIdle();
    setStatus(t("st_stopped"), t("hint_stopped"), "", "");
    say("l_userstop");
    toast(t("st_stopped"));
  });

  $("btn-skip").addEventListener("click", () => {
    window.sniper.skip();
    say("l_userskip");
  });

  $("btn-repair").addEventListener("click", async () => {
    $("btn-repair").disabled = true;
    beginRun();
    setStatus(t("st_repair"), t("hint_repair_run"), "run", "");
    const ok = await window.sniper.repair();
    if (!ok) {
      running = false;
      setButtons();
      showRepair(true);
    }
  });

  document.querySelectorAll(".f").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".f").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      const body = $("cn-body");
      body.classList.remove("f-ok", "f-err");
      if (btn.dataset.filter !== "all") body.classList.add("f-" + btn.dataset.filter);
    });
  });

  $("log").addEventListener("scroll", () => {
    const box = $("log");
    stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (stickToBottom) $("jump").hidden = true;
  });

  $("jump").addEventListener("click", () => {
    const box = $("log");
    box.scrollTop = box.scrollHeight;
    stickToBottom = true;
    $("jump").hidden = true;
  });

  $("btn-copylog").addEventListener("click", async () => {
    const text = logText();
    if (!text) { toast(t("m_empty")); return; }
    await window.sniper.copyText(text);
    flash($("btn-copylog"), $("copylog-label"), "copy");
  });

  $("btn-clearlog").addEventListener("click", () => {
    $("log").replaceChildren();
    $("cn-body").classList.remove("live");
    $("jump").hidden = true;
  });

  const openTg = () => window.sniper.openExternal(TELEGRAM_URL);
  const openGh = () => window.sniper.openExternal(GITHUB_URL);
  $("lnk-tg").addEventListener("click", openTg);
  $("lnk-tg2").addEventListener("click", openTg);
  $("lnk-gh").addEventListener("click", openGh);
  $("lnk-gh2").addEventListener("click", openGh);
  $("gh-handle").textContent = GITHUB_URL.replace(/^https:\/\/github\.com\//, "");

  $("btn-help").addEventListener("click", () => showModal("modal-help"));
  $("btn-settings").addEventListener("click", () => showModal("modal-settings"));
  $("btn-quests").addEventListener("click", () => showModal("modal-quests"));
  $("setting-startup").addEventListener("change", () => persistSettings({ launchAtLogin: $("setting-startup").checked }));
  $("setting-tray").addEventListener("change", () => persistSettings({ minimizeToTray: $("setting-tray").checked }));
  $("setting-theme").addEventListener("change", () => persistSettings({ theme: $("setting-theme").value }));
  $("setting-orb-only").addEventListener("change", () => persistSettings({ orbOnly: $("setting-orb-only").checked }));
  $("setting-prioritize").addEventListener("change", () => persistSettings({ prioritizeOrbs: $("setting-prioritize").checked }));
  $("btn-donate").addEventListener("click", () => showModal("modal-donate"));
  $("scrim").addEventListener("click", closeModal);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); closeLangMenu(); if (!$("finish").hidden) closeFinish(); }
  });

  $("btn-copyaddr").addEventListener("click", async () => {
    await window.sniper.copyText($("cr-addr").textContent.trim());
    flash($("btn-copyaddr"), $("copyaddr-label"), "copy");
  });

  window.sniper.onLog(addLog);
  window.sniper.onSay(({ key, level, args }) => pushLine(t(key, ...(args || [])), level || "info"));
  window.sniper.onEvent(onEngineEvent);
  window.sniper.onPhase(setPhase);
  window.sniper.onProgress(updateQuest);
  window.sniper.onQuests((items) => {
    questItems = Array.isArray(items) ? items : [];
    renderQuestQueue();
  });
  window.sniper.onAccount((account) => {
    if (!account) return;
    const name = account.displayName || account.username || "Discord account";
    const username = account.username && account.username !== name ? ` · @${account.username}` : "";
    $("f-account").textContent = name + username;
    $("account-strip").hidden = false;
  });
  window.sniper.onBalance(({ value }) => {
    $("f-orbs").textContent = value == null ? "—" : Number(value).toLocaleString();
    if (value != null) $("account-strip").hidden = false;
  });
  window.sniper.onTally(renderTally);
  window.sniper.onRunning((isRunning) => { running = isRunning; setButtons(); });

  // "Everything is done" no longer means the session ended: the watcher keeps
  // looking for new quests, so Stop stays available and the status stays live.
  window.sniper.onDone((summary) => {
    if (summary) tally = Object.assign({}, tally, summary);
    setProgress(100);
    setStatus(t("st_done"), tally.manual ? t("hint_done_manual") : t("hint_done"), "ok", "done");
    setButtons();
    say(tally.manual ? "l_alldone_manual" : "l_alldone");
    showFinish();
  });

  $("btn-fin-ok").addEventListener("click", closeFinish);
  $("btn-fin-donate").addEventListener("click", () => { closeFinish(); showModal("modal-donate"); });
});
