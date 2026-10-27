/*!
 * OrbSniper - renderer
 * (c) 2026 synaps_ss - tg: @synaps_ss
 */

const GITHUB_URL = "https://github.com/syntaxixr/OrbSniper";
const TELEGRAM_URL = "https://t.me/synaps_ss";
const TOS_URL = "https://discord.com/terms";

// Discord help centre locale codes; anything missing redirects to en-us
const POLICY_LOCALE = { ru: "ru", en: "en-us", de: "de", fr: "fr", es: "es", pl: "pl", tr: "tr", pt: "pt-br", uk: "en-us", zh: "en-us" };
const policyUrl = () =>
  `https://support.discord.com/hc/${POLICY_LOCALE[lang] || "en-us"}/articles/115002192352`;

const $ = (id) => document.getElementById(id);
const LOG_LIMIT = 400;

let lang = "ru";
let running = false;
let claimed = 0;
let stickToBottom = true;
let tally = { total: 0, done: 0, left: 0, manual: 0 };

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

// ---------- current quest ----------
const fmtTime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function updateQuest(p) {
  if (!p || !p.quest) return;
  const pct = p.need > 0 ? Math.min(100, Math.round((p.done / p.need) * 100)) : 0;
  setProgress(pct);
  $("facts").hidden = false;
  $("f-target").textContent = p.quest;
  $("f-pct").textContent = pct + "%";
  $("f-time").textContent = fmtTime(p.elapsed);
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

// ---------- disclaimer ----------
// Shown on every launch: the user has to confirm the risk each time.
function closeGate() {
  const gate = $("gate");
  gate.classList.add("closing");
  setTimeout(() => { gate.hidden = true; gate.classList.remove("closing"); }, 260);
}

function initGate() {
  const gate = $("gate");
  const box = $("agree-box");
  box.checked = false;
  $("btn-agree").disabled = true;
  gate.hidden = false;

  box.addEventListener("change", (e) => {
    $("btn-agree").disabled = !e.target.checked;
  });

  $("btn-agree").addEventListener("click", () => {
    if (!box.checked) return;
    closeGate();
  });

  $("btn-quit").addEventListener("click", () => window.sniper.close());
  $("lnk-policy").addEventListener("click", () => window.sniper.openExternal(policyUrl()));
  $("lnk-tos").addEventListener("click", () => window.sniper.openExternal(TOS_URL));
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
  initGate();

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
