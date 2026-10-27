/*!
 * OrbSniper - checks that run without Discord, Electron or a network.
 * node test/run.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
// Line endings are normalised because a checkout can be CRLF, and in JavaScript
// "." does not match \r - it counts as a line terminator. Without this, every
// regex here silently stops matching on a Windows checkout.
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  ok   " + name); })
    .catch((e) => { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message ? e.message : e)); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// Loads I18N/LANGS out of the renderer bundle without a browser.
function loadI18N() {
  const s = {};
  new Function("g", read("renderer/i18n.js") + "\ng.I18N = I18N; g.LANGS = LANGS;")(s);
  return s;
}

// Pulls a top-level function out of main.js so it can be exercised directly.
// main.js requires electron on load, so it cannot simply be require()d here.
function grabFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start !== -1, `function ${name} not found in main.js`);
  const end = source.indexOf("\n}", start);
  assert(end !== -1, `end of ${name} not found`);
  return source.slice(start, end + 2);
}

// Fake webpack registry using export names that are deliberately NOT the ones
// the old engine hardcoded. If the shape-based lookup works, the minified
// names are irrelevant - which is the whole point of the change.
// A Discord that keeps score. The stub it replaces answered 200 to everything,
// which is precisely the blindness that let "accepted" and "reward claimed" be
// printed while nothing had happened on the account.
function apiServer(opts) {
  const seen = [];
  const page = { status: 404, body: '<!DOCTYPE html><html><head><title>Page Not Found</title></head></html>' };
  const state = new Map();
  const at = (id) => {
    if (!state.has(id)) state.set(id, { enrolled: false, seconds: 0, completed: false, claimed: false });
    return state.get(id);
  };
  const questOf = (id) => (opts.quests ? opts.quests.get(id) : null);
  const targetOf = (q) => {
    const tasks = q && q.config && q.config.taskConfig && q.config.taskConfig.tasks;
    const t = tasks && (tasks.WATCH_VIDEO || tasks.PLAY_ON_DESKTOP);
    return t ? t.target : 0;
  };
  const stamp = (q, field) => { q.userStatus = Object.assign({}, q.userStatus, { [field]: "now" }); };

  function handle(url, body) {
    seen.push(url);
    if (url === "/users/@me") return { status: 200, body: { id: "42" } };
    if (url.indexOf("/applications/public") === 0) return { status: 200, body: [] };

    const m = /^\/quests\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return page;
    const q = questOf(m[1]);
    if (!q) return page;
    const st = at(m[1]);

    if (m[2] === "enroll") {
      st.enrolled = true;
      stamp(q, "enrolledAt");
      return { status: 200, body: { type: "success" } };
    }
    if (m[2] === "video-progress") {
      if (!st.enrolled) return { status: 400, body: { message: "not enrolled" } };
      // opts.frozen: the server accepts the call but records nothing, the way
      // it behaves when the client is not really watching.
      if (!opts.frozen) {
        st.seconds = Math.max(st.seconds, Math.floor((body && body.timestamp) || 0));
        if (st.seconds >= targetOf(q)) { st.completed = true; stamp(q, "completedAt"); }
      }
      return { status: 200, body: { completed_at: st.completed ? "now" : null } };
    }
    if (m[2] === "heartbeat") {
      if (!st.enrolled) return { status: 400, body: { message: "not enrolled" } };
      return { status: 200, body: { progress: {} } };   // never advances
    }
    if (m[2] === "claim-reward") {
      if (!st.completed) return { status: 400, body: { errors: [{ message: "quest not completed" }] } };
      st.claimed = true;
      stamp(q, "claimedAt");
      return { status: 200, body: { ok: true } };
    }
    return page;
  }

  return { handle, seen, state };
}

// A minimal quest of the kind these tests care about: one video task.
function videoQuest(id, name, userStatus, target) {
  return {
    id,
    config: {
      expiresAt: "2099-01-01T00:00:00Z",
      messages: { questName: name },
      application: { id: "app-" + id, name: name },
      taskConfig: { tasks: { WATCH_VIDEO: { target: target == null ? 5 : target } } }
    },
    userStatus: userStatus || null
  };
}

// A play-on-desktop quest: progress can only come from the server, so when the
// server never credits it the quest genuinely goes nowhere.
function playQuest(id, name) {
  return {
    id,
    config: {
      expiresAt: "2099-01-01T00:00:00Z",
      messages: { questName: name },
      application: { id: "app-" + id, name: name },
      taskConfig: { tasks: { PLAY_ON_DESKTOP: { target: 60 } } }
    },
    userStatus: null
  };
}

function fakeDiscord(opts) {
  opts = opts || {};
  const store = Object.assign(
    Object.create({ getQuest() { return null; } }),
    { quests: opts.quests || new Map() }
  );
  const flux = Object.create({ dispatch() {}, subscribe() {}, unsubscribe() {} });
  const server = apiServer(opts);

  const modules = {
    // Decoy listed first on purpose: same four verbs, but it talks to the web
    // app, so every answer is a page. Picking it is the bug this guards.
    a0: { exports: { yY: {
      get() { return Promise.resolve({ status: 200, body: "<!DOCTYPE html><html></html>" }); },
      post() { return Promise.resolve({ status: 200, body: "<!DOCTYPE html><html></html>" }); },
      put() {}, patch() {}
    } } },
    // The real client, backed by a Discord that keeps score.
    // opts.positional makes it accept only (url, {body}), the shape newer
    // Discord builds use.
    a1: { exports: { zZ: {
      get(a) {
        if (opts.positional && typeof a !== "string") return Promise.reject({ status: 404, body: "<!doctype html>" });
        if (opts.apiBroken) return Promise.resolve({ status: 200, body: "<!DOCTYPE html><html></html>" });
        const url = typeof a === "string" ? a : (a && a.url);
        return Promise.resolve(server.handle(url));
      },
      post(a, b) {
        if (opts.positional && typeof a !== "string") return Promise.reject({ status: 404, body: "<!doctype html>" });
        if (opts.apiBroken) return Promise.resolve({ status: 200, body: "<!DOCTYPE html><html></html>" });
        const url = typeof a === "string" ? a : (a && a.url);
        const body = typeof a === "string" ? (b && b.body) : (a && a.body);
        return Promise.resolve(server.handle(url, body));
      },
      put() {}, patch() {}
    } } },
    a2: { exports: { qQ7: flux } },
    a3: { exports: { Wp: store } },
    // decoy: has getQuest but no quest map, must not win
    a4: { exports: { Kk: Object.create({ getQuest() { return null; } }) } },
    a5: { exports: { mN: Object.create({ getRunningGames() { return []; }, getGameForPID() {} }) } },
    a6: { exports: { pL: Object.create({ getStreamerActiveStreamMetadata() {} }) } },
    a7: { exports: { rT: Object.create({ getSortedPrivateChannels() { return []; } }) } },
    a8: { exports: { vB: Object.create({ getAllGuilds() { return {}; } }) } },
    // hostile module: touching it throws, the scan must survive
    a9: { get exports() { throw new Error("boom"); } }
  };
  if (opts.empty) for (const k of Object.keys(modules)) delete modules[k];

  const wpRequire = { c: modules };
  const chunk = [];
  chunk.push = function (arg) {
    if (Array.isArray(arg) && typeof arg[2] === "function") return arg[2](wpRequire);
    return Array.prototype.push.call(this, arg);
  };
  chunk.pop = function () {};
  chunk.__server = server;
  return chunk;
}

// Runs quest.js in a sandbox and collects the events it emits.
async function runEngine(opts) {
  const events = [];
  const sandbox = {
    console: {
      log(msg) {
        if (typeof msg === "string" && msg.startsWith("__ORBSNIPER__")) {
          try { events.push(JSON.parse(msg.slice("__ORBSNIPER__".length))); } catch (_) {}
        }
      },
      error() {}
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Symbol, Math, Date, JSON, Map, Set, Object, Array, String, Number, Promise, RegExp, Error
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The engine only fakes a running game when it believes it is inside the
  // desktop client, which is where it always runs in practice.
  if (opts && opts.desktop) sandbox.DiscordNative = {};

  let chunk = null;
  if (!(opts && opts.noWebpack)) {
    chunk = fakeDiscord(opts || {});
    sandbox.webpackChunkdiscord_app = chunk;
  }

  const ctx = vm.createContext(sandbox);
  let src = read("quest.js").replace("__ORB_SESSION__", "test-session");

  // Only the waiting is shortened, never a decision. Real durations would make
  // an end-to-end run take minutes; the logic under test is untouched.
  if (opts && opts.fast) {
    const before = src;
    src = src
      // Kept comfortably above one video step, or a quest would be called
      // stalled while it is legitimately waiting. A test that wants a
      // stall asks for a short threshold explicitly.
      .replace("STALL_TIMEOUT_MS = 3 * 60 * 1000", "STALL_TIMEOUT_MS = " + (opts.stallMs || 2500))
      .replace("SCAN_INTERVAL_MS = 20 * 1000", "SCAN_INTERVAL_MS = 60")
      .replace("QUEST_RETRY_MS = 60 * 1000", "QUEST_RETRY_MS = 40")
      .replace("ENROLL_COOLDOWN_MS = 3 * 60 * 1000", "ENROLL_COOLDOWN_MS = 40")
      .replace("CLAIM_COOLDOWN_MS = 5 * 60 * 1000", "CLAIM_COOLDOWN_MS = 40")
      .split("await sleep(2000)").join("await sleep(10)")
      .split("await sleep(20 * 1000)").join("await sleep(25)");
    if (src === before) throw new Error("fast mode rewrote nothing - the timing constants moved");
  }

  vm.runInContext(src, ctx, { filename: "quest.js" });

  await sleep((opts && opts.wait) || 250);
  if (sandbox.window.__ORB__) sandbox.window.__ORB__.stop = true;
  await sleep(60);
  return { events, sandbox, server: chunk && chunk.__server };
}

(async function main() {
  console.log("\nOrbSniper test suite\n");

  console.log("syntax");
  for (const f of ["main.js", "preload.js", "quest.js", "renderer/app.js", "renderer/i18n.js", "scripts/dist.js", "test/run.js"]) {
    await check(f + " parses", () => {
      execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    });
  }

  console.log("\ntranslations");
  const { I18N, LANGS } = loadI18N();
  await check("every language in LANGS has a dictionary", () => {
    for (const l of LANGS) assert(I18N[l.code], `no dictionary for ${l.code}`);
  });
  await check("all languages share the exact same key set", () => {
    const ref = Object.keys(I18N.ru).sort();
    for (const [code, dict] of Object.entries(I18N)) {
      const keys = Object.keys(dict).sort();
      const missing = ref.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !ref.includes(k));
      assert(!missing.length && !extra.length,
        `${code}: missing [${missing.join(",")}] extra [${extra.join(",")}]`);
    }
  });
  await check("no empty strings and no leftover placeholders", () => {
    for (const [code, dict] of Object.entries(I18N)) {
      for (const [k, v] of Object.entries(dict)) {
        assert(typeof v === "string" && v.trim().length > 0, `${code}.${k} is empty`);
        assert(!/\{\d+\}\s*\{\d+\}\{/.test(v), `${code}.${k} looks malformed`);
      }
    }
  });
  await check("placeholder counts match the Russian source", () => {
    const count = (s) => new Set((s.match(/\{\d\}/g) || [])).size;
    for (const [code, dict] of Object.entries(I18N)) {
      if (code === "ru") continue;
      for (const k of Object.keys(I18N.ru)) {
        assert(count(dict[k]) === count(I18N.ru[k]),
          `${code}.${k} has ${count(dict[k])} placeholders, ru has ${count(I18N.ru[k])}`);
      }
    }
  });
  await check("every key used in code exists in the dictionary", () => {
    const code = read("renderer/app.js") + read("main.js") + read("renderer/index.html");
    const used = new Set();
    for (const m of code.matchAll(/\bt\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of code.matchAll(/\bsay\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of code.matchAll(/data-i18n="([a-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of code.matchAll(/"((?:l_|chk_|hint_|st_|fin_)[a-z0-9_]+)"/g)) used.add(m[1]);
    const missing = [...used].filter((k) => !(k in I18N.ru));
    assert(!missing.length, "missing keys: " + missing.join(", "));
  });

  console.log("\nengine <-> UI contract");
  await check("renderer handles every event the engine can emit", () => {
    const quest = read("quest.js");
    const emitted = new Set();
    for (const m of quest.matchAll(/ev:\s*"([a-z_]+)"/g)) emitted.add(m[1]);
    for (const m of quest.matchAll(/die\(\s*"([a-z_]+)"/g)) emitted.add(m[1]);
    // handled either by the launcher or by the renderer's EVENTS table
    const app = read("renderer/app.js");
    const handledInUI = new Set();
    const table = app.slice(app.indexOf("const EVENTS"), app.indexOf("function onEngineEvent"));
    for (const m of table.matchAll(/^\s{2}([a-z_]+):/gm)) handledInUI.add(m[1]);
    const launcherOnly = new Set(["progress", "tally", "all_done", "alive"]);
    const unhandled = [...emitted].filter((e) => !handledInUI.has(e) && !launcherOnly.has(e));
    assert(!unhandled.length, "events with no UI handling: " + unhandled.join(", "));
  });
  await check("launcher forwards the events the renderer expects", () => {
    const main = read("main.js");
    for (const ch of ["sniper:event", "sniper:progress", "sniper:tally", "sniper:done"]) {
      assert(main.includes(`"${ch}"`), `main.js never sends ${ch}`);
    }
    const preload = read("preload.js");
    for (const ch of ["sniper:event", "sniper:progress", "sniper:tally", "sniper:done", "sniper:say", "sniper:phase", "sniper:running", "sniper:log"]) {
      assert(preload.includes(`"${ch}"`), `preload.js never bridges ${ch}`);
    }
  });

  console.log("\nDiscord module lookup (the reason it failed on other machines)");
  await check("finds every store despite unknown minified export names", async () => {
    const { events } = await runEngine();
    const failed = events.find((e) => e.ev === "modules_failed");
    assert(!failed, "modules_failed: " + (failed && failed.missing));
    assert(events.some((e) => e.ev === "started"), "engine never reported 'started'");
  });
  await check("survives a module whose exports getter throws", async () => {
    const { events } = await runEngine();
    assert(!events.some((e) => e.ev === "crashed"), "engine crashed on a hostile module");
  });
  await check("picks the store that actually holds the quest map", async () => {
    const quests = new Map();
    const { events } = await runEngine({ quests });
    assert(!events.some((e) => e.ev === "modules_failed"), "decoy store won the lookup");
    assert(events.some((e) => e.ev === "tally"), "never produced a tally, so the map was wrong");
  });
  await check("reports missing modules instead of throwing", async () => {
    const { events } = await runEngine({ empty: true });
    const f = events.find((e) => e.ev === "modules_failed");
    assert(f, "no modules_failed event");
    assert(!events.some((e) => e.ev === "crashed"), "crashed instead of reporting");
  });
  await check("reports a missing webpack cleanly", async () => {
    const { events } = await runEngine({ noWebpack: true });
    const f = events.find((e) => e.ev === "modules_failed");
    assert(f && f.missing === "webpack", "did not report the webpack case");
  });
  await check("never claims completion when it actually failed", async () => {
    const { events } = await runEngine({ empty: true });
    assert(!events.some((e) => e.ev === "all_done"),
      "a failed run still emitted all_done - the old false-completion bug");
  });
  await check("a second injection evicts the first instead of lying", async () => {
    const { events } = await runEngine();
    assert(!events.some((e) => e.ev === "dup"), "fresh run should not report dup");
  });

  console.log("\nfast portable launch");
  await check("the release build uses our portable launcher", () => {
    const pkg = JSON.parse(read("package.json"));
    assert(pkg.scripts.dist.includes("scripts/dist.js"),
      "npm run dist bypasses scripts/dist.js - the exe would unpack on every launch again");
    const dist = read("scripts/dist.js");
    assert(dist.includes('"portable.nsi"') && dist.includes("nsisTemplatesDir"),
      "scripts/dist.js no longer swaps in build/portable.nsi");
  });
  await check("the launcher unpacks once and reuses the cache", () => {
    const nsi = read("build/portable.nsi");
    assert(nsi.includes('${FileExists} "${CACHE_DIR}\\.complete"'), "no fast path for an already unpacked build");
    assert(nsi.indexOf('FileOpen $0 "${CACHE_DIR}\\.complete"') > nsi.indexOf("File /r"),
      "the cache is marked complete before the unpack has finished");
    assert(/CACHE_DIR "[^"]*\$\{BUILD_ID\}"/.test(nsi) && read("scripts/dist.js").includes("!define BUILD_ID"),
      "the cache folder is not tied to the build, a new exe could run old files");
    assert(!nsi.includes("Nsis7z"), "back to the 7z layout: the first unpack is twice as slow");
    const pkg = JSON.parse(read("package.json"));
    assert(pkg.build.portable.useZip === true, "portable.useZip is off: the launcher needs the app as plain files");
    assert(!/^\s*ExecWait\b/m.test(nsi), "the launcher waits for the app, keeping a stub process around");
    assert(nsi.includes("CreateMutex"), "two quick double-clicks could unpack into the same folder at once");
  });

  console.log("\nDiscord version picking");
  const mainSrc = read("main.js");
  await check("newest app-* build wins", () => {
    const ctx = { };
    vm.createContext(ctx);
    vm.runInContext(grabFunction(mainSrc, "versionTuple") + "\n" + grabFunction(mainSrc, "compareVersions"), ctx);
    const folders = ["app-1.0.887", "app-1.0.9013", "app-1.0.9200", "app-1.0.10001"];
    const sorted = folders.slice().sort(ctx.compareVersions);
    assert(sorted[0] === "app-1.0.10001",
      "sorted to " + sorted.join(", ") + " - oldest build would be launched");
  });
  await check("version comparison handles odd names", () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(grabFunction(mainSrc, "versionTuple") + "\n" + grabFunction(mainSrc, "compareVersions"), ctx);
    assert(ctx.compareVersions("app-2.0.0", "app-1.9.9") < 0, "major version ignored");
    assert(typeof ctx.compareVersions("weird", "app-1.0.0") === "number", "threw on a junk name");
  });

  console.log("\nhardening regressions");
  await check("no hardcoded C:\\Windows escape bug", () => {
    assert(!/"C:\\W/.test(mainSrc), 'found "C:\\Windows" - \\W is not an escape and collapses to C:Windows');
  });
  await check("AppData is read from the environment", () => {
    assert(mainSrc.includes("process.env.LOCALAPPDATA"), "LOCALAPPDATA not used");
    assert(mainSrc.includes("process.env.APPDATA"), "APPDATA not used");
  });
  await check("all Discord branches are searched", () => {
    for (const b of ["DiscordPTB", "DiscordCanary"]) {
      assert(mainSrc.includes(b), b + " is never looked for");
    }
  });
  await check("a busy debug port is not fatal", () => {
    assert(mainSrc.includes("choosePort"), "no alternative port selection");
    assert(!mainSrc.includes("chk_port_foreign"), "still treats a foreign port holder as fatal");
  });
  await check("kill failure is not decided by localised text", () => {
    assert(!/Отказано/.test(mainSrc), "still matches Russian taskkill output that arrives in another codepage");
  });
  await check("every failure path clears the running flag", () => {
    assert(mainSrc.includes("function fail("), "no single failure helper");
    const bad = mainSrc.match(/phase\("error"\)/g) || [];
    assert(bad.length <= 2, "phase('error') is set in " + bad.length + " places instead of going through fail()");
  });
  await check("engine control flags are namespaced and session-checked", () => {
    assert(mainSrc.includes("window.__ORB__"), "does not use the new control object");
    assert(mainSrc.includes("__ORB__.session"), "injection is not verified by session id");
  });
  await check("Discord settings are backed up and never clobbered", () => {
    assert(mainSrc.includes(".orbsniper.bak"), "no backup before writing Discord settings");
    assert(mainSrc.includes("l_settings_odd"), "damaged settings file is not reported");
  });

  console.log("\nquest engine safety");
  const questSrc = read("quest.js");
  // Comments describe the bugs that were fixed, so they must not be searched.
  const questCode = questSrc
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s+\/\/\s.*$/, ""))
    .join("\n");

  await check("no unguarded api call inside a loop", () => {
    const lines = questCode.split("\n");
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/await api\.(post|get)\(/.test(line)) return;
      // guarded by a try on this line, or by one opened just above
      if (/try\s*\{/.test(line)) return;
      const before = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
      const opens = (before.match(/try\s*\{/g) || []).length;
      const closes = (before.match(/\}\s*catch/g) || []).length;
      if (opens <= closes) offenders.push(i + 1);
    });
    assert(!offenders.length, "unguarded api calls on lines " + offenders.join(", "));
  });
  await check("every async worker carries a catch", () => {
    const workers = questCode.match(/\}\)\(\)(\.catch\()?/g) || [];
    const withCatch = workers.filter((w) => w.includes(".catch(")).length;
    assert(workers.length > 0, "no async workers found");
    assert(withCatch >= 3, `only ${withCatch} of ${workers.length} async workers have a catch`);
  });
  await check("processQuest always settles", () => {
    assert(questCode.includes("const guard = setTimeout(() => settle("), "no hard time limit on a quest");
    assert(questCode.includes("if (settled) return;"), "no settle guard");
  });
  await check("optional chaining on the activity heartbeat response", () => {
    assert(!/res\.body\.progress\.PLAY_ACTIVITY\.value/.test(questCode),
      "still dereferences the activity response without guards");
    assert(/res\?\.body\?\.progress\?\.PLAY_ACTIVITY\?\.value/.test(questCode),
      "the guarded form is missing");
  });
  await check("does not delete window.$", () => {
    assert(!/delete window\.\$/.test(questCode), "still mutates the page's global $");
  });
  await check("no polled globals left over from the old protocol", () => {
    for (const g of ["__QUEST_STATUS__", "__QUEST_TALLY__", "__QUEST_AUTO_DONE__", "__QUEST_WATCHER__"]) {
      assert(!questCode.includes(g), g + " is still there - the polling protocol was not removed");
      assert(!mainSrc.includes(g), g + " is still polled by the launcher");
    }
  });

  await check("every API call goes through the shape-probing wrapper", () => {
    const direct = questCode.split("\n").filter((l) => /\bapi\.(post|get)\s*\(/.test(l));
    assert(direct.length === 0,
      "quest.js calls api." + (direct[0] || "").trim() + " directly - a client that wants " +
      "(url, {body}) would get the object stringified into the request path");
    assert(/const apiPost = /.test(questCode) && /const apiGet = /.test(questCode),
      "the apiPost/apiGet wrappers are missing");
  });

  await check("the API client is chosen by asking it, not by its shape", async () => {
    // A decoy with the same four verbs is scanned first. If shape alone were
    // trusted, the engine would send every quest to the web app and read its
    // pages as success.
    const quests = new Map([["q1", videoQuest("q1", "AION 2")]]);
    const { events: evs } = await runEngine({ quests });
    assert(evs.some((e) => e.ev === "started"), "engine never started with a decoy API present");
    assert(!evs.some((e) => e.ev === "api_unusable"), "the real client was rejected");
    // The decoy answers every call with a page. Only the real client can turn
    // an enrol into an acceptance, so this is what separates them.
    assert(evs.some((e) => e.ev === "accepted"), "the decoy won: nothing was ever really accepted");
  });

  await check("a client that only takes (url, {body}) still works", async () => {
    const { events: evs } = await runEngine({ positional: true });
    assert(evs.some((e) => e.ev === "started"), "the newer call shape was never found");
    assert(!evs.some((e) => e.ev === "api_unusable"), "gave up on a client that does work");
  });

  await check("an API that only answers pages is reported, not used", async () => {
    // The failure that made quests look accepted while nothing reached the
    // account. Silence here is worse than an error.
    const { events: evs } = await runEngine({ apiBroken: true });
    assert(evs.some((e) => e.ev === "api_unusable"), "a useless API was accepted as working");
    assert(!evs.some((e) => e.ev === "accepted" || e.ev === "claimed"),
      "reported progress through an API that cannot work");
  });

  await check("an error page never reaches the console", () => {
    const HTML = '<!DOCTYPE html><html lang="ru"><head><title>Page Not Found</title></head>' +
                 "<body>" + "<div>filler</div>".repeat(400) + "</body></html>";
    const src = questCode.slice(questCode.indexOf("const clean ="), questCode.indexOf("const isCaptcha"));
    const ctx = { module: {} };
    vm.createContext(ctx);
    vm.runInContext(src + "\nmodule.clean = clean; module.describe = describe;", ctx);

    for (const out of [ctx.module.clean(HTML), ctx.module.describe(HTML), ctx.module.describe({ body: HTML })]) {
      assert(!/<[a-z!]/i.test(out), "markup leaked into the message: " + out.slice(0, 80));
      assert(out.length <= 200, "message is " + out.length + " chars - an error page would flood the log");
    }
  });

  await check("a quest the server never credits is not counted as done", async () => {
    // The server accepts every call but records no progress - what a wrong API
    // client looked like from the inside. One quest is genuinely claimed, the
    // other only thinks it is. "left" used to come from our own bookkeeping,
    // so the second one vanished from the count and the app announced that
    // everything was finished.
    const quests = new Map([
      ["q1", videoQuest("q1", "done one", { enrolledAt: "x", completedAt: "x", claimedAt: "x" })],
      ["q2", videoQuest("q2", "todo one", null, 0)]
    ]);
    const { events } = await runEngine({ quests, frozen: true, fast: true, wait: 1500 });
    const last = events.filter((e) => e.ev === "tally").pop();
    assert(last, "no tally was ever produced");
    assert(last.total === 2, "total was " + last.total + ", expected 2");
    assert(last.done === 1, "done was " + last.done + ", expected 1");
    assert(last.left === 1, "left was " + last.left + ", expected 1 - an unfinished quest went missing");
    assert(!events.some((e) => e.ev === "all_done"), "announced that everything was finished");
    assert(!events.some((e) => e.ev === "claimed" && e.quest === "todo one"),
      "reported a reward the server refused to give");
  });

  await check("a quest that did not finish is not filed away as if it had", () => {
    // The line that used to sit here marked every quest handled the moment
    // processQuest returned, whatever the outcome.
    const tail = questCode.slice(questCode.indexOf("const outcome = await processQuest"));
    assert(tail, "processQuest result is not captured at all");
    const upToNextLoop = tail.slice(0, 1200);
    assert(/outcome === "done"/.test(upToNextLoop),
      "the outcome is captured but never checked before filing the quest away");
    assert(/retryAt\.set/.test(upToNextLoop),
      "a quest that did not finish gets no second chance");
    assert(!/^\s*processed\.add\(quest\.id\);\s*$/m.test(upToNextLoop.split("if (outcome")[0]),
      "the quest is still filed away unconditionally");
  });

  await check("a stalled quest does not spend its claim tries", () => {
    const body = questCode.slice(questCode.indexOf("function settle(reason)"));
    const upToEnd = body.slice(0, body.indexOf("const stopped"));
    const claimAt = upToEnd.indexOf("claimReward");
    const guardAt = upToEnd.indexOf('reason !== "done"');
    assert(guardAt !== -1, "settle no longer separates a finished quest from a stalled one");
    assert(claimAt > guardAt, "claiming still runs before the outcome is checked");
  });

  await check("every fatal engine event stops the launcher", () => {
    // die() ends the engine. If the launcher does not treat the event as a
    // failure it keeps thinking the run is alive and re-injects on the
    // proof-of-life timeout, over and over.
    const fatal = [...questSrc.matchAll(/die\("([a-z_]+)"/g)].map((m) => m[1]);
    assert(fatal.length, "no die() calls found - the pattern moved");

    const main = read("main.js");
    const handled = main.slice(main.indexOf("function handleEngineEvent"));
    for (const ev of new Set(fatal)) {
      if (ev === "stopped") continue;   // the ordinary end of a run
      assert(handled.includes('case "' + ev + '"'),
        "main.js never treats " + ev + " as the end of the run");
    }
  });

  console.log("\nend to end");

  await check("four quests are carried from untouched to claimed", async () => {
    // The whole point of the app, checked against a Discord that keeps score.
    // Every assertion below reads the server's own record, not our log, so a
    // run that only prints success cannot pass.
    const quests = new Map();
    for (let i = 1; i <= 4; i++) quests.set("q" + i, videoQuest("q" + i, "quest " + i, null, i === 4 ? 1 : 0));

    const { events, server } = await runEngine({ quests, fast: true, wait: 6000 });

    for (let i = 1; i <= 4; i++) {
      const id = "q" + i;
      const st = server.state.get(id);
      assert(st, "quest " + i + " was never touched at all");
      assert(st.enrolled, "quest " + i + " was never enrolled");
      assert(st.completed, "quest " + i + " never reached its target");
      assert(st.claimed, "quest " + i + " was never claimed");
      assert(quests.get(id).userStatus.claimedAt, "the account has no claim recorded for quest " + i);
    }

    const last = events.filter((e) => e.ev === "tally").pop();
    assert(last && last.total === 4, "tally total: " + JSON.stringify(last));
    assert(last.done === 4, "tally says " + last.done + " claimed, the server says 4");
    assert(last.left === 0, "tally still lists " + last.left + " to do");
    const done = events.filter((e) => e.ev === "all_done");
    assert(done.length === 1, "all_done fired " + done.length + " times, expected once");
  });

  await check("a quest that never progresses is retried, then handed back", async () => {
    // Progress for a play quest can only come from the server, and this one
    // never credits any. The quest must not be quietly dropped, and it must
    // not be reported as finished.
    const quests = new Map([["p1", playQuest("p1", "stuck one")]]);
    const { events } = await runEngine({ quests, desktop: true, fast: true, stallMs: 150, wait: 4000 });

    assert(events.some((e) => e.ev === "quest_later"), "a stalled quest was never given a second try");
    assert(events.some((e) => e.ev === "quest_gaveup"), "gave up silently instead of handing it back");
    assert(!events.some((e) => e.ev === "claimed"), "claimed a reward for a quest that never moved");
    assert(!events.some((e) => e.ev === "all_done"), "announced that everything was finished");

    const last = events.filter((e) => e.ev === "tally").pop();
    assert(last && last.left === 1, "the stuck quest vanished from the count: " + JSON.stringify(last));
    assert(last.manual === 1, "the stuck quest was not flagged as needing a hand");
  });

  console.log("\njournal");
  await check("the console caps every line, whatever the engine sends", () => {
    // Independent of quest.js: if a future Discord change floods us again,
    // the journal itself must still print a line, not a web page.
    const appSrc = read("renderer/app.js");
    const src = appSrc.slice(appSrc.indexOf("const LINE_LIMIT"), appSrc.indexOf("function pushLine"));
    assert(src, "the journal has no length guard at all");

    const ctx = { module: {}, t: (k) => k };
    vm.createContext(ctx);
    vm.runInContext(src + "\nmodule.tidy = tidy;", ctx);

    const page = '<!DOCTYPE html><html lang="ru"><head><title>Page Not Found</title></head>' +
                 "<body>" + "<div>filler</div>".repeat(500) + "</body></html>";
    assert(ctx.module.tidy(page) === "l_errpage", "an error page is not recognised as one");
    assert(ctx.module.tidy("<b>bold</b> claim") === "bold claim", "markup is not stripped");
    assert(ctx.module.tidy("x".repeat(4000)).length <= 240, "a long line is not truncated");
    assert(ctx.module.tidy("plain message") === "plain message", "an ordinary line was mangled");
  });

  await check("every language can name an error page", () => {
    const { I18N, LANGS } = loadI18N();
    const missing = LANGS.filter((l) => !I18N[l.code] || !I18N[l.code].l_errpage);
    assert(missing.length === 0, "l_errpage missing in: " + missing.map((l) => l.code).join(", "));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
