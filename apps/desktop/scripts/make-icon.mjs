/**
 * Draws Bragi's placeholder app icon and writes it as a PNG, for `tauri icon`.
 * Run once from the repository root:
 *   node scripts/make-icon.mjs
 * The generated icon set in apps/desktop/src-tauri/icons is committed; this
 * script is only here so the icon is reproducible and self-made (no third-party
 * artwork, 13 §1 rule 7).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const BACKGROUND = [14, 16, 22]; // dark, like the canvas (11 §3)
const FOREGROUND = [127, 211, 255]; // ice, the "piano" role colour

/** Distance from the centre, normalised to 0..1. */
function radius(x, y) {
  const dx = (x - SIZE / 2) / (SIZE / 2);
  const dy = (y - SIZE / 2) / (SIZE / 2);
  return Math.hypot(dx, dy);
}

const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 3 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const r = radius(x, y);
    // A rounded square with a soft ring inside it.
    const inSquare = Math.max(Math.abs(x - SIZE / 2), Math.abs(y - SIZE / 2)) < SIZE * 0.44;
    const inRing = r > 0.34 && r < 0.46;
    const colour = !inSquare ? [0, 0, 0] : inRing ? FOREGROUND : BACKGROUND;
    const offset = rowStart + 1 + x * 3;
    raw[offset] = colour[0];
    raw[offset + 1] = colour[1];
    raw[offset + 2] = colour[2];
  }
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};

const table = (() => {
  const values = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[n] = c >>> 0;
  }
  return values;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 2; // colour type: truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = process.argv[2] ?? "apps/desktop/src-tauri/icons/source.png";
writeFileSync(fileURLToPath(new URL(`../../../${target}`, import.meta.url)), png);
console.log(`wrote ${target} (${png.length} bytes)`);
