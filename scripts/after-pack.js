/*!
 * OrbSniper - electron-builder afterPack hook
 *
 * Drops parts of the Electron runtime this app never uses, to keep the exe
 * small. OrbSniper's window is plain HTML and CSS: no WebGPU, no WebGL, no
 * Vulkan, no sound.
 *
 *   dxcompiler.dll, dxil.dll   DirectX shader compiler, only for WebGPU
 *   vk_swiftshader.dll + .json software Vulkan, only for WebGL/WebGPU
 *                              without a usable GPU
 *   vulkan-1.dll               Vulkan loader, Chromium's Vulkan backend is
 *                              off by default on Windows
 *   d3dcompiler_47.dll         a copy of what Windows 10 and 11 already ship
 *                              in System32; Chromium falls back to that one
 *   chrome_200_percent.pak     Chromium's own bitmaps for 200% displays; it
 *                              falls back to the 100% set, and this UI draws
 *                              none of them anyway
 *
 * Without a GPU, Chromium still draws this UI with its software compositor.
 *
 * Inside resources.pak, the built-in FLAC sounds (~5 MB, and FLAC does not
 * compress any further) are emptied. The entries stay in the table, so any
 * lookup still succeeds - it just gets no data.
 */

const fs = require("fs");
const path = require("path");

const UNUSED = [
  "dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll",
  "d3dcompiler_47.dll", "chrome_200_percent.pak"
];

// Chromium .pak, version 5:
//   u32 version, u8 encoding, 3 bytes padding, u16 resources, u16 aliases,
//   (resources + 1) x { u16 id, u32 offset }, aliases x { u16 id, u16 index },
//   then the data. Offsets are absolute; the last entry marks the end.
function emptyPakEntries(file, shouldEmpty) {
  const d = fs.readFileSync(file);
  if (d.readUInt32LE(0) !== 5) return 0;
  const count = d.readUInt16LE(8);
  const aliases = d.readUInt16LE(10);
  const table = 12;
  const dataStart = table + 6 * (count + 1) + 4 * aliases;

  const header = Buffer.from(d.subarray(0, dataStart));
  const chunks = [];
  let offset = dataStart;
  let saved = 0;
  for (let i = 0; i < count; i++) {
    const from = d.readUInt32LE(table + 6 * i + 2);
    const to = d.readUInt32LE(table + 6 * (i + 1) + 2);
    const data = d.subarray(from, to);
    header.writeUInt32LE(offset, table + 6 * i + 2);
    if (shouldEmpty(data)) {
      saved += data.length;
    } else {
      chunks.push(data);
      offset += data.length;
    }
  }
  header.writeUInt32LE(offset, table + 6 * count + 2);
  if (!saved) return 0;
  fs.writeFileSync(file, Buffer.concat([header, ...chunks]));
  return saved;
}

const isFlac = (data) => data.length > 4 && data.toString("latin1", 0, 4) === "fLaC";

exports.default = async function afterPack(context) {
  let saved = 0;
  for (const name of UNUSED) {
    const f = path.join(context.appOutDir, name);
    try {
      saved += fs.statSync(f).size;
      fs.unlinkSync(f);
    } catch (_) {}
  }
  saved += emptyPakEntries(path.join(context.appOutDir, "resources.pak"), isFlac);
  console.log(`  dropped unused Electron parts: ${(saved / 1048576).toFixed(1)} MB`);
};
