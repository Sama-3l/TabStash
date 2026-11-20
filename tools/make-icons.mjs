/**
 * Generates the TabStash PNG icons without external dependencies.
 * Run: node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
const SS = 4; // supersampling factor

function insideRoundedRect(x, y, rect) {
  const { x: rx, y: ry, w, h, r } = rect;
  if (x < rx || x > rx + w || y < ry || y > ry + h) return false;
  const cx = Math.max(rx + r, Math.min(x, rx + w - r));
  const cy = Math.max(ry + r, Math.min(y, ry + h - r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function render(size) {
  const s = size * SS;
  const buf = new Float32Array(s * s * 4);

  const bg = { x: 0, y: 0, w: s, h: s, r: s * 0.285 };
  const bars = [
    { x: s * 0.219, y: s * 0.281, w: s * 0.562, h: s * 0.156, r: s * 0.078, alpha: 0.96 },
    { x: s * 0.281, y: s * 0.516, w: s * 0.438, h: s * 0.125, r: s * 0.062, alpha: 0.74 },
    { x: s * 0.344, y: s * 0.703, w: s * 0.312, h: s * 0.1, r: s * 0.05, alpha: 0.48 },
  ];

  const c1 = [91, 124, 250];
  const c2 = [124, 77, 255];

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const i = (y * s + x) * 4;
      if (!insideRoundedRect(x + 0.5, y + 0.5, bg)) {
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
        buf[i + 3] = 0;
        continue;
      }
      const t = (x + y) / (2 * s);
      let r = mix(c1[0], c2[0], t);
      let g = mix(c1[1], c2[1], t);
      let b = mix(c1[2], c2[2], t);
      let a = 1;

      for (const bar of bars) {
        if (insideRoundedRect(x + 0.5, y + 0.5, bar)) {
          r = mix(r, 255, bar.alpha);
          g = mix(g, 255, bar.alpha);
          b = mix(b, 255, bar.alpha);
          a = 1;
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a * 255;
    }
  }

  // Box-filter down to the final size, using premultiplied alpha.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * s + (x * SS + sx)) * 4;
          const alpha = buf[i + 3] / 255;
          r += buf[i] * alpha;
          g += buf[i + 1] * alpha;
          b += buf[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      out[o] = alpha > 0.0001 ? Math.round(r / a) : 0;
      out[o + 1] = alpha > 0.0001 ? Math.round(g / a) : 0;
      out[o + 2] = alpha > 0.0001 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size));
  writeFileSync(join(OUT, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png (${png.length} bytes)`);
}
