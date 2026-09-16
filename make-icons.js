/* Generates the PWA PNG icons by rasterizing the Theeti logo
   (cream rounded square, sage leaves, dark bowl, highlight).
   Run:  node make-icons.js   — rerun anytime the logo changes. */
"use strict";
const zlib = require("zlib");
const fs = require("fs");

const CREAM = [250, 246, 236];
const DARK = [46, 66, 52];
const SAGE = [139, 168, 136];

/* --- minimal PNG encoder (8-bit RGBA) --- */
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --- shape tests in logo coordinates (viewBox 200x200) --- */
function inRoundedRect(x, y, cx, cy, half, r) {
  const dx = Math.max(Math.abs(x - cx) - (half - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (half - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function inEllipse(x, y, cx, cy, rx, ry, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = x - cx, dy = y - cy;
  const u = dx * Math.cos(a) + dy * Math.sin(a);
  const v = -dx * Math.sin(a) + dy * Math.cos(a);
  return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

function inBowl(x, y) {
  return y >= 85 && ((x - 101) * (x - 101)) / (71.5 * 71.5) + ((y - 85) * (y - 85)) / (81 * 81) <= 1;
}

/* --- render one icon --- */
function render(size, maskable) {
  const img = Buffer.alloc(size * size * 4);
  const scale = 200 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let x, y;
      if (maskable) {
        // artwork at ~68% so it stays inside the safe zone
        x = 100 + ((px + 0.5) / size - 0.5) * (200 / 0.68);
        y = 100 + ((py + 0.5) / size - 0.5) * (200 / 0.68);
      } else {
        x = (px + 0.5) * scale;
        y = (py + 0.5) * scale;
      }

      let r = 0, g = 0, b = 0, a = 255;
      const onBg = maskable || inRoundedRect(x, y, 100, 100, 100, 40);
      if (!onBg) {
        a = 0; // transparent corners (regular icon)
      } else {
        r = CREAM[0]; g = CREAM[1]; b = CREAM[2];
        if (inEllipse(x, y, 134, 49, 42, 17, -46)) { r = SAGE[0]; g = SAGE[1]; b = SAGE[2]; }   // big leaf
        if (inEllipse(x, y, 72, 63, 29, 13, 40))  { r = SAGE[0]; g = SAGE[1]; b = SAGE[2]; }   // small leaf
        if (inBowl(x, y)) {
          r = DARK[0]; g = DARK[1]; b = DARK[2];
          if (distToSeg(x, y, 148, 100, 116, 153) < 4) { r = CREAM[0]; g = CREAM[1]; b = CREAM[2]; } // highlight
        }
      }
      const i = (py * size + px) * 4;
      img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = a;
    }
  }
  return png(size, size, img);
}

const path = require("path");
const here = __dirname; // always write icons next to this script
fs.writeFileSync(path.join(here, "icon-192.png"), render(192, false));
fs.writeFileSync(path.join(here, "icon-512.png"), render(512, false));
fs.writeFileSync(path.join(here, "icon-maskable-512.png"), render(512, true));
fs.writeFileSync(path.join(here, "icon-apple-180.png"), render(180, true));
console.log("icons written: icon-192.png, icon-512.png, icon-maskable-512.png, icon-apple-180.png");
