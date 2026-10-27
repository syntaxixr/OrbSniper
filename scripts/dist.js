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

fs.rmSync(COPY, { recursive: true, force: true });
fs.cpSync(stock, COPY, { recursive: true });
fs.copyFileSync(OURS, path.join(COPY, "portable.nsi"));

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
