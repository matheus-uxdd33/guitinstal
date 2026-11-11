'use strict';

/**
 * Writes the app icon PNGs.
 *
 * build/guitinstal-logo.png is the artwork the product ships with, so when it
 * is there the tool only copies it. Without that file it falls back to drawing
 * the placeholder squircle + geometric "G" — pure node, zlib for the PNG data,
 * no image dependency.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded square, so the corners antialias for free. */
function sdRoundRect(x, y, half, radius) {
  const dx = Math.abs(x) - half + radius;
  const dy = Math.abs(y) - half + radius;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function ringDistance(x, y, radius, thickness) {
  return Math.abs(Math.hypot(x, y) - radius) - thickness / 2;
}

function coverage(distance) {
  return Math.min(1, Math.max(0, 0.5 - distance));
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const badge = half * 0.94;
  const corner = size * 0.225;

  const startBlue = [46, 107, 230];
  const endViolet = [124, 68, 192];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Center of each pixel, in a coordinate system where y grows upwards.
      const cx = x + 0.5 - half;
      const cy = half - (y + 0.5);

      const badgeAlpha = coverage(sdRoundRect(cx, cy, badge, corner));
      if (badgeAlpha <= 0) continue;

      const t = (x + y) / (2 * size);
      const glyph = [lerp(startBlue[0], endViolet[0], t), lerp(startBlue[1], endViolet[1], t), lerp(startBlue[2], endViolet[2], t)];

      const radius = size * 0.3;
      const stroke = size * 0.115;
      const gapHalf = Math.PI / 5.5; // opening on the right side
      const angle = Math.atan2(cy, cx);
      const inGap = Math.abs(angle) < gapHalf;

      let glyphAlpha = coverage(ringDistance(cx, cy, radius, stroke));
      if (inGap) {
        // Close the ring above and below the terminal bar.
        const ring = coverage(ringDistance(cx, cy, radius, stroke));
        const capTop = coverage(Math.max(Math.abs(cx - radius * 0.62) - stroke / 2, cy - radius * 0.92));
        glyphAlpha = Math.max(ring * (cy > radius * 0.35 ? 1 : 0), capTop);
      }

      // Terminal bar: horizontal arm that turns the ring into a "G".
      const arm = coverage(
        Math.max(
          Math.abs(cy + size * 0.02) - stroke / 2,
          Math.abs(cx - size * 0.16) - size * 0.17,
        ),
      );
      glyphAlpha = Math.min(1, glyphAlpha + arm);

      const bgTop = [16, 19, 28];
      const bgBottom = [7, 8, 12];
      const vertical = 1 - (y + 0.5) / size;

      let r = lerp(bgBottom[0], bgTop[0], vertical);
      let g = lerp(bgBottom[1], bgTop[1], vertical);
      let b = lerp(bgBottom[2], bgTop[2], vertical);

      const a = Math.min(1, glyphAlpha);
      r = lerp(r, glyph[0], a);
      g = lerp(g, glyph[1], a);
      b = lerp(b, glyph[2], a);

      // Soft inner glow behind the monogram.
      const glow = Math.max(0, 1 - Math.hypot(cx, cy) / (half * 0.95)) * 0.16;
      r = Math.min(255, r + glow * 90);
      g = Math.min(255, g + glow * 70);
      b = Math.min(255, b + glow * 150);

      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(badgeAlpha * 255);
    }
  }
  return px;
}

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const logo = path.join(__dirname, '..', 'build', 'guitinstal-logo.png');
if (fs.existsSync(logo)) {
  const target = path.join(__dirname, '..', 'build', 'icon.png');
  fs.copyFileSync(logo, target);
  // ui/icon-128.png and ui/icon-256.png are the same artwork resampled for the
  // window and the sidebar, so they are only rewritten by the fallback below.
  console.log(`${target} (${fs.statSync(target).size} bytes, from guitinstal-logo.png)`);
  process.exit(0);
}

for (const size of [1024, 512, 256, 128]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, size, render(size)));
  console.log(`${file} (${fs.statSync(file).size} bytes)`);
}

const main = path.join(outDir, 'icon.png');
fs.copyFileSync(path.join(outDir, 'icon-512.png'), main);
fs.copyFileSync(path.join(outDir, 'icon-256.png'), path.join(__dirname, '..', 'ui', 'icon-256.png'));
fs.copyFileSync(path.join(outDir, 'icon-128.png'), path.join(__dirname, '..', 'ui', 'icon-128.png'));
console.log(main);
