/*!
 * OrbSniper v1.6.0 - Discord Orb farmer (GUI)
 * Copyright (c) 2026 synaps_ss - tg: @synaps_ss
 * Licensed under MIT. Use at your own risk. Violates Discord ToS.
 */

const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");

const DONATE_ADDRESS = "TJXGAkovUoA2z9C7mWBiB9SGLVQu6oSsf";
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const WebSocket = require("ws");

const VERSION = "1.6.0";

// 9222 is the conventional CDP port, which is exactly why it is so often taken
// by some other Electron app. We try it first and fall back to a free one.
const DEFAULT_PORT = 9222;
const PORT_RANGE_END = 9260;

const EVENT_TAG = "__ORBSNIPER__";
const ALIVE_TIMEOUT_MS = 90 * 1000;   // no engine event for this long -> re-inject
const RECONNECT_TRIES = 20;           // Discord restarts (updates) are survivable

let win = null;
const state = {
  running: false,
  stopping: false,      // user pressed Stop: do not auto-reconnect
  ws: null,
  msgId: 0,
  port: 0,
  session: "",
  target: null,
  readyPoll: null,
  watchdog: null,
  lastEventAt: 0,
  injecting: false,
  injected: false,
  pending: new Map()    // CDP message id -> handler
};

// ---------- UI helpers ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function uiLog(msg) { send("sniper:log", msg); }
function say(key, level, ...args) { send("sniper:say", { key, level, args }); }
function phase(p) { send("sniper:phase", p); }
function setRunning(v) { state.running = v; send("sniper:running", v); }

// Every failure path must go through here. Leaving state.running true was what
// wedged the UI: the Start button stayed disabled and runFlow() returned early
// on its own guard forever after.
function fail(key, level, ...args) {
  if (key) say(key, level || "err", ...args);
  phase("error");
  stopEngine(false);
  setRunning(false);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Windows helpers ----------
// Full paths, because a broken PATH is a real thing on other people's machines
// and "tasklist" alone then resolves to nothing.
const SYS32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const sysExe = (name) => {
  const full = path.join(SYS32, name);
  return fs.existsSync(full) ? full : name;
};

function runTool(name, args) {
  try {
    return execFileSync(sysExe(name), args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15000
    });
  } catch (_) { return ""; }
}

// Are we elevated? High Mandatory Level means "as administrator".
function isElevated() {
  return runTool("whoami.exe", ["/groups"]).includes("S-1-16-12288");
}

function discordPids() {
  const out = runTool("tasklist.exe", ["/FI", "IMAGENAME eq Discord.exe", "/FO", "CSV", "/NH"]);
  return out.split("\n")
    .map((l) => l.split('","')[1])
    .filter((x) => x && /^\d+$/.test(x.trim()))
    .map((x) => parseInt(x, 10));
}

function processName(pid) {
  const out = runTool("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const m = out.match(/^"([^"]+)"/);
  return m ? m[1] : "";
}

function pidOnPort(port) {
  const out = runTool("netstat.exe", ["-ano", "-p", "TCP"]);
  for (const line of out.split("\n")) {
    if (!line.includes("LISTENING")) continue;
    if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(pid)) return pid;
  }
  return 0;
}

// ---------- finding Discord ----------
// Discord keeps every installed build in its own app-<version> folder and does
// not always delete the old ones. The previous version matched /app-(\d+)/,
// which captures "1" out of "app-1.0.9253" for every folder alike, so the
// comparator always returned 0 and the FIRST one alphabetically won - usually
// the oldest build, which then just hands off to the updater and never opens
// the debug port. This compares real version tuples.
function versionTuple(name) {
  const m = String(name).match(/app-([\d.]+)/);
  if (!m) return [0];
  return m[1].split(".").map((n) => parseInt(n, 10) || 0);
}
function compareVersions(a, b) {
  const va = versionTuple(a);
  const vb = versionTuple(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Path of an already-running Discord: the most reliable answer there is, and it
// covers installs in places we would never guess.
function runningDiscordExe() {
  const ps = path.join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(ps)) return null;
  try {
    const out = execFileSync(ps, [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-Process -Name Discord -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)"
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 15000 }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch (_) { return null; }
}

// Every Discord branch, not just stable, and via the environment rather than
// homedir()+"AppData": a redirected or OneDrive-backed profile breaks the
// hardcoded path and the app then claims Discord is not installed.
function findDiscordExe() {
  const running = runningDiscordExe();
  if (running) return running;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const branches = ["Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment"];
  const candidates = [];

  for (const branch of branches) {
    const base = path.join(localAppData, branch);
    let entries = [];
    try { entries = fs.readdirSync(base); } catch (_) { continue; }
    const apps = entries.filter((e) => e.startsWith("app-")).sort(compareVersions);
    for (const entry of apps) {
      for (const exe of ["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "DiscordDevelopment.exe"]) {
        candidates.push(path.join(base, entry, exe));
      }
    }
  }

  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"]) {
    if (!root) continue;
    for (const branch of branches) candidates.push(path.join(root, branch, `${branch}.exe`));
  }

  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function manualCommand(exe, port) {
  return `"${exe}" --remote-debugging-port=${port}`;
}

// ---------- Discord settings ----------
function discordSettingsPath() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(roaming, "discord", "settings.json");
}

// Writes one flag into Discord's settings. If the file cannot be parsed we now
// leave it alone instead of replacing the user's whole configuration with a
// single key, and we keep a backup either way.
function enableDevTools() {
  try {
    const settingsPath = discordSettingsPath();
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf8");
      try {
        settings = JSON.parse(raw);
      } catch (_) {
        say("l_settings_odd", "warn");
        return;
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
      try { fs.writeFileSync(settingsPath + ".orbsniper.bak", raw); } catch (_) {}
    }
    if (settings.DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING === true) return;
    settings.DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING = true;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (_) {}
}

function settingsWritable() {
  try {
    const dir = path.dirname(discordSettingsPath());
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".orbsniper-probe");
    fs.writeFileSync(probe, "1");
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

// ---------- ports ----------
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// Remembering the port means a Discord we started earlier is still reachable
// after the launcher is restarted.
function portFile() {
  try { return path.join(app.getPath("userData"), "port.json"); } catch (_) { return null; }
}
function rememberPort(port) {
  try { const f = portFile(); if (f) fs.writeFileSync(f, JSON.stringify({ port })); } catch (_) {}
}
function rememberedPort() {
  try {
    const f = portFile();
    if (!f || !fs.existsSync(f)) return 0;
    const p = JSON.parse(fs.readFileSync(f, "utf8")).port;
    return Number.isInteger(p) ? p : 0;
  } catch (_) { return 0; }
}

// A port held by something that is not Discord is no longer fatal: we simply
// use a different one. That alone fixes a whole class of "works for you, not
// for me" reports, because 9222 is the default for every other Electron app.
async function choosePort() {
  if (await portFree(DEFAULT_PORT)) return DEFAULT_PORT;
  const pid = pidOnPort(DEFAULT_PORT);
  if (pid && /discord/i.test(processName(pid))) return DEFAULT_PORT; // ours, reuse
  for (let p = DEFAULT_PORT + 1; p <= PORT_RANGE_END; p++) {
    if (await portFree(p)) return p;
  }
  return 0;
}

// ---------- CDP discovery ----------
async function fetchTargets(port, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: ctl.signal });
    clearTimeout(timer);
    return await res.json();
  } catch (_) { return null; }
}

const mainPageOf = (targets) =>
  (targets || []).find((t) => t.type === "page" && t.webSocketDebuggerUrl && /discord\.com\/(app|channels)/.test(t.url)) || null;

// Is a usable Discord already sitting on one of the ports we might have used?
async function probeExisting() {
  const ports = [];
  const saved = rememberedPort();
  if (saved) ports.push(saved);
  if (!ports.includes(DEFAULT_PORT)) ports.push(DEFAULT_PORT);
  for (const port of ports) {
    const page = mainPageOf(await fetchTargets(port));
    if (page) return { port, page };
  }
  return null;
}

async function waitForMainPage(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let sawPort = false;
  let lastNotice = 0;

  while (Date.now() < deadline) {
    if (state.stopping) return null;
    const targets = await fetchTargets(port, 2000);
    const waited = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);

    if (targets) {
      if (!sawPort) {
        sawPort = true;
        say("l_portup", "ok", String(targets.filter((t) => t.type === "page").length));
      }
      const main = mainPageOf(targets);
      if (main) return main;
      const loggedIn = targets.some((t) => t.type === "page" && /discord\.com/.test(t.url));
      if (loggedIn && waited - lastNotice >= 15) { lastNotice = waited; say("l_waitlogin", "warn"); }
    } else if (waited - lastNotice >= 10) {
      lastNotice = waited;
      say("l_waiting", "info", String(waited));
    }
    await sleep(1500);
  }
  return null;
}

// ---------- killing / launching ----------
function killDiscord() {
  try {
    execFileSync(sysExe("taskkill.exe"), ["/F", "/IM", "Discord.exe", "/T"], {
      stdio: "pipe", windowsHide: true, timeout: 15000
    });
    return true;
  } catch (_) { return false; }
}

// Returns { ok, denied }.
//
// "denied" used to be decided by matching the words "Access is denied" in
// taskkill's output. On a non-English Windows that output arrives in the OEM
// codepage while it is read as UTF-8, so the match never fired and the hint
// about administrator rights was never shown. Survival of the process after
// several attempts is both language-independent and more honest.
async function killDiscordAndWait(timeoutMs = 15000) {
  const started = Date.now();
  let attempt = 0;

  while (Date.now() - started < timeoutMs) {
    const pids = discordPids();
    if (pids.length === 0) return { ok: true, denied: false };

    attempt++;
    killDiscord();
    if (attempt > 2) {
      for (const pid of pids) {
        try {
          execFileSync(sysExe("taskkill.exe"), ["/F", "/PID", String(pid), "/T"], {
            stdio: "pipe", windowsHide: true, timeout: 10000
          });
        } catch (_) {}
      }
    }
    await sleep(700);
  }
  const alive = discordPids().length > 0;
  return { ok: !alive, denied: alive && !isElevated() };
}

function launchDiscord(exe, port) {
  try {
    const child = spawn(exe, [`--remote-debugging-port=${port}`], {
      detached: true, stdio: "ignore", windowsHide: false
    });
    child.unref();
    return true;
  } catch (e) {
    uiLog("[!] Failed to launch Discord: " + (e && e.message ? e.message : e));
    return false;
  }
}

// ---------- CDP session ----------
function cdp(method, params, onResult) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
  const id = ++state.msgId;
  if (onResult) state.pending.set(id, onResult);
  try { ws.send(JSON.stringify({ id, method, params: params || {} })); }
  catch (_) { state.pending.delete(id); return 0; }
  return id;
}
function evalInPage(expression, onResult) {
  return cdp("Runtime.evaluate", { expression, returnByValue: true }, onResult);
}

function injectEngine() {
  if (state.injecting) return;
  state.injecting = true;

  const session = crypto.randomUUID();
  state.session = session;

  let code;
  try {
    code = fs.readFileSync(path.join(__dirname, "quest.js"), "utf8").replace("__ORB_SESSION__", session);
  } catch (e) {
    state.injecting = false;
    fail("l_injectfail", "err", String((e && e.message) || e));
    return;
  }

  say("l_injecting", "info");
  evalInPage(code, (result) => {
    const ex = result && result.exceptionDetails;
    if (ex) {
      state.injecting = false;
      const why = (ex.exception && ex.exception.description) || ex.text || "unknown";
      fail("l_injectfail", "err", String(why).split("\n")[0]);
      return;
    }
    // Sending the script is not the same as it running. The engine reports its
    // own session id back; anything else means we are not actually farming.
    setTimeout(() => {
      evalInPage(
        `(window.__ORB__ && window.__ORB__.session === ${JSON.stringify(session)} && window.__ORB__.alive === true)`,
        (r) => {
          state.injecting = false;
          if (r && r.result && r.result.value === true) {
            state.injected = true;
            state.lastEventAt = Date.now();
            phase("farming");
            say("l_injected_ok", "ok");
          } else {
            fail("l_injectdead", "err");
          }
        }
      );
    }, 3000);
  });
}

function handleEngineEvent(e) {
  state.lastEventAt = Date.now();
  // Ignore leftovers from an evicted watcher.
  if (e.s && state.session && e.s !== state.session) return;

  switch (e.ev) {
    case "started":
      state.injected = true;
      phase("farming");
      break;
    case "tally":
      send("sniper:tally", { total: e.total, done: e.done, left: e.left, manual: e.manual });
      return;
    case "progress":
      send("sniper:progress", { quest: e.quest, task: e.task, done: e.done, need: e.need, elapsed: e.elapsed });
      return;
    case "all_done":
      send("sniper:done", { done: e.done, manual: e.manual });
      break;
    // Both of these mean the engine has stopped for good. Without the second
    // one the launcher kept believing a run was alive and re-injected on the
    // proof-of-life timeout, forever.
    case "modules_failed":
    case "api_unusable":
      send("sniper:event", e);
      fail(null);
      return;
    case "crashed":
      send("sniper:event", e);
      fail(null);
      return;
    case "alive":
      return;
    default:
      break;
  }
  send("sniper:event", e);
}

function connect(port, target) {
  state.port = port;
  state.target = target;
  rememberPort(port);

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  state.ws = ws;
  state.msgId = 0;
  state.pending.clear();
  state.injected = false;
  state.injecting = false;

  ws.on("open", () => {
    cdp("Runtime.enable");
    cdp("Page.enable");

    let attempts = 0;
    clearInterval(state.readyPoll);
    state.readyPoll = setInterval(() => {
      if (state.injected || state.injecting || ws.readyState !== WebSocket.OPEN) return;
      if (++attempts > 60) {
        clearInterval(state.readyPoll);
        state.readyPoll = null;
        fail("l_notready", "err");
        return;
      }
      evalInPage("typeof webpackChunkdiscord_app !== 'undefined'", (r) => {
        if (r && r.result && r.result.value === true) {
          clearInterval(state.readyPoll);
          state.readyPoll = null;
          injectEngine();
        }
      });
    }, 2000);
  });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }

    if (msg.id && state.pending.has(msg.id)) {
      const cb = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      try { cb(msg.result); } catch (_) {}
      return;
    }

    if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description) ?? "").join(" ");
      if (typeof args === "string" && args.startsWith(EVENT_TAG)) {
        let payload;
        try { payload = JSON.parse(args.slice(EVENT_TAG.length)); } catch (_) { return; }
        handleEngineEvent(payload);
      }
      return;
    }

    // The page reloaded (Discord updated itself, or the user hit Ctrl+R): the
    // engine went with it, so put it back instead of pretending to farm.
    if (msg.method === "Runtime.executionContextsCleared" || msg.method === "Page.loadEventFired") {
      if (state.injected && !state.stopping) {
        state.injected = false;
        say("l_reinject", "warn");
        setTimeout(() => { if (!state.stopping && state.ws === ws) injectEngine(); }, 4000);
      }
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(state.readyPoll);
    state.readyPoll = null;
    if (state.ws !== ws) return;
    state.ws = null;
    state.injected = false;
    if (state.stopping || !state.running) return;
    say("l_disconnected", "warn");
    reconnect();
  });

  ws.on("error", (e) => uiLog("[!] WebSocket error: " + e.message));
}

// Discord updates itself regularly, and an update restarts the client. That
// used to end the session silently with the UI still showing "farming".
async function reconnect() {
  phase("waiting");
  for (let i = 0; i < RECONNECT_TRIES; i++) {
    if (state.stopping) return;
    await sleep(3000);
    const found = await probeExisting();
    if (found) {
      say("l_reconnected", "ok");
      phase("connecting");
      connect(found.port, found.page);
      return;
    }
  }
  fail("l_lost", "err");
}

// Catches the case where the socket stays open but the engine is gone.
function startWatchdog() {
  clearInterval(state.watchdog);
  state.watchdog = setInterval(() => {
    if (!state.running || state.stopping || !state.injected) return;
    if (Date.now() - state.lastEventAt < ALIVE_TIMEOUT_MS) return;
    say("l_reinject", "warn");
    state.injected = false;
    state.lastEventAt = Date.now();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) injectEngine();
  }, 15000);
}

// ---------- preflight ----------
function canReachDiscord() {
  return new Promise((resolve) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    fetch("https://discord.com/api/v9/gateway", { signal: ctl.signal })
      .then((r) => { clearTimeout(timer); resolve(r.ok || r.status === 401); })
      .catch(() => { clearTimeout(timer); resolve(false); });
  });
}

async function preflight() {
  say("chk_start", "info");
  let fatal = false;

  const exe = findDiscordExe();
  if (exe) say("chk_discord_ok", "ok", exe);
  else { say("chk_discord_missing", "err"); fatal = true; }

  if (isElevated()) say("chk_elevated", "ok");
  if (settingsWritable()) say("chk_settings_ok", "ok");
  else { say("chk_settings_fail", "err"); fatal = true; }

  const port = await choosePort();
  if (!port) { say("chk_port_none", "err"); fatal = true; }
  else if (port === DEFAULT_PORT) say("chk_port_free", "ok", String(port));
  else say("chk_port_alt", "ok", String(port));   // taken by someone else: not our problem any more

  if (await canReachDiscord()) say("chk_net_ok", "ok");
  else { say("chk_net_fail", "err"); fatal = true; }

  if (fatal) { say("chk_stop", "err"); return null; }
  say("chk_pass", "ok");
  return { exe, port };
}

// ---------- main flow ----------
async function runFlow() {
  if (state.running) return;
  state.stopping = false;
  setRunning(true);
  startWatchdog();

  try {
    // Fast path first: a Discord already listening on a port we know needs no
    // restart at all, which skips every failure mode below.
    const existing = await probeExisting();
    if (existing) {
      say("l_already", "ok");
      phase("connecting");
      connect(existing.port, existing.page);
      return;
    }

    const pre = await preflight();
    if (!pre) { fail(null); return; }
    const { exe, port } = pre;

    // Only restart Discord when it is actually running without the port. If it
    // is closed we just start it, and nothing has to be killed.
    if (discordPids().length > 0) {
      phase("closing");
      say("l_closing", "info");
      const closed = await killDiscordAndWait();
      if (!closed.ok) {
        say(closed.denied ? "l_killdenied" : "l_killfail", "err");
        say("l_manualcmd", "warn", manualCommand(exe, port));
        fail(null);
        return;
      }
      say("l_closed", "ok");
    }

    enableDevTools();

    phase("launching");
    say("l_launching", "info");
    if (!launchDiscord(exe, port)) { fail(null); return; }

    phase("waiting");
    const target = await waitForMainPage(port);
    if (!target) {
      if (state.stopping) return;
      say("l_nowindow_help", "err");
      say("l_manualcmd", "warn", manualCommand(exe, port));
      fail(null);
      return;
    }

    phase("connecting");
    connect(port, target);
  } catch (e) {
    uiLog("[!] Fatal: " + ((e && e.message) || e));
    fail(null);
  }
}

// ---------- stop / repair ----------
function stopEngine(tellEngine) {
  if (tellEngine) {
    try { evalInPage("window.__ORB__ && (window.__ORB__.stop = true)"); } catch (_) {}
  }
  clearInterval(state.readyPoll);
  state.readyPoll = null;
  const ws = state.ws;
  state.ws = null;
  if (ws) {
    try { ws.removeAllListeners(); } catch (_) {}
    // Give the stop flag a moment to reach the page before dropping the socket.
    setTimeout(() => { try { ws.close(); } catch (_) {} }, tellEngine ? 300 : 0);
  }
  state.pending.clear();
  state.injected = false;
  state.injecting = false;
  state.session = "";
}

function stopFlow() {
  state.stopping = true;
  clearInterval(state.watchdog);
  state.watchdog = null;
  stopEngine(true);
  setRunning(false);
}

ipcMain.handle("sniper:start", () => { runFlow(); return true; });

ipcMain.handle("sniper:repair", async () => {
  say("l_repair_start", "info");
  stopFlow();

  const closed = await killDiscordAndWait(20000);
  if (!closed.ok) {
    say(closed.denied ? "l_killdenied" : "l_killfail", "err");
    const exe = findDiscordExe();
    if (exe) say("l_manualcmd", "warn", manualCommand(exe, rememberedPort() || DEFAULT_PORT));
    phase("error");
    return false;
  }

  say("l_repair_done", "ok");
  await sleep(800);
  state.stopping = false;
  runFlow();
  return true;
});

ipcMain.handle("sniper:stop", () => { stopFlow(); return true; });
ipcMain.handle("sniper:skip", () => { evalInPage("window.__ORB__ && (window.__ORB__.skip = true)"); return true; });
ipcMain.handle("app:copy", (_e, text) => { clipboard.writeText(String(text || "")); return true; });
ipcMain.handle("app:version", () => VERSION);
ipcMain.handle("app:donateAddress", () => DONATE_ADDRESS);
ipcMain.handle("app:open", (_e, url) => {
  const u = String(url || "");
  if (!/^https:\/\//i.test(u)) return false;   // https only
  shell.openExternal(u);
  return true;
});
ipcMain.handle("win:minimize", () => { if (win) win.minimize(); });
ipcMain.handle("win:close", () => { if (win) win.close(); });

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 740,
    minWidth: 600,
    minHeight: 600,
    frame: false,
    resizable: true,
    // Shown straight away instead of on ready-to-show: the window is up a
    // good part of a second sooner, and painting it in the page's own
    // background colour means there is no white flash before the UI arrives.
    backgroundColor: "#06070a",
    icon: path.join(__dirname, "icon.ico"),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
