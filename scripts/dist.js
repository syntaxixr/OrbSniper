/*!
 * OrbSniper - release build
 * node scripts/dist.js
 *
 * Same as `electron-builder --win`, with one change: the portable exe gets our
 * own launcher script (build/portable.nsi) instead of electron-builder's.
 *
 * electron-builder has no option for a custom portable script - it always
 * reads templates/nsis/portable.nsi. It does read that folder through the
 * exported nsisTemplatesDir property, so we copy the folder, drop our script
 * in, and point the property at the copy. Nothing in node_modules is touched.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OURS = path.join(ROOT, "build", "portable.nsi");
const COPY = path.join(ROOT, "dist", ".nsis-templates");

const nsisUtil = require("app-builder-lib/out/targets/nsis/nsisUtil");
const stock = nsisUtil.nsisTemplatesDir;
if (!stock || !fs.existsSync(path.join(stock, "portable.nsi"))) {
  console.error("electron-builder's NSIS templates were not found where expected: " + stock);
  console.error("The build tooling changed; check scripts/dist.js before releasing.");
  process.exit(1);
}

// The launcher caches the unpacked app in a folder named after this id, so it
// has to change whenever anything that ends up inside the exe changes.
function buildId() {
  const crypto = require("crypto");
  const h = crypto.createHash("sha256");
  const add = (p) => {
    const full = path.join(ROOT, p);
    if (fs.statSync(full).isDirectory()) {
      for (const e of fs.readdirSync(full).sort()) add(path.join(p, e));
    } else {
      h.update(p.replace(/\\/g, "/") + "\0");
      h.update(fs.readFileSync(full));
    }
  };
  for (const p of ["main.js", "preload.js", "quest.js", "renderer", "icon.ico", "package.json"]) add(p);
  for (const dep of ["electron", "ws"]) {
    h.update(dep + "@" + require(path.join(ROOT, "node_modules", dep, "package.json")).version + "\0");
  }
  return h.digest("hex").slice(0, 16).toUpperCase();
}

const id = buildId();
fs.rmSync(COPY, { recursive: true, force: true });
fs.cpSync(stock, COPY, { recursive: true });
fs.writeFileSync(path.join(COPY, "portable.nsi"),
  `!define BUILD_ID "${id}"\n` + fs.readFileSync(OURS, "utf8"));
console.log("  build id " + id);

nsisUtil.nsisTemplatesDir = COPY;
if (nsisUtil.nsisTemplatesDir !== COPY) {
  console.error("Could not redirect electron-builder's NSIS templates.");
  process.exit(1);
}

const { build, Platform } = require("electron-builder");

build({ targets: Platform.WINDOWS.createTarget(), publish: "never" })
  .then((files) => {
    for (const f of files) console.log("  built " + path.relative(ROOT, f));
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
