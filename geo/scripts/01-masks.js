'use strict';
/* 01-masks.js — classify scan pixels into red (boundaries/labels) and yellow (MZ area) masks.
 * Outputs debug PNGs (downscaled) + color histogram to tune thresholds. */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SRC = path.join(__dirname, '..', 'pdf-pages', 'page-1.png');
const OUT = path.join(__dirname, '..', 'debug');
fs.mkdirSync(OUT, { recursive: true });

const png = PNG.sync.read(fs.readFileSync(SRC));
const W = png.width, H = png.height, data = png.data;
console.log(`loaded ${SRC}: ${W}x${H}`);

const red = new Uint8Array(W * H);
const yellow = new Uint8Array(W * H);
const hist = new Map();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    hist.set(key, (hist.get(key) || 0) + 1);
    if (r > 110 && r - g > 45 && r - b > 45) {
      red[y * W + x] = 1;
    } else if (r > 130 && g > 115 && r - b > 25 && g - b > 15 && r - g < 60) {
      yellow[y * W + x] = 1;
    }
  }
}

let redN = 0, yelN = 0;
for (let i = 0; i < red.length; i++) { redN += red[i]; yelN += yellow[i]; }
console.log(`red px: ${redN} (${(100 * redN / (W * H)).toFixed(2)}%), yellow px: ${yelN} (${(100 * yelN / (W * H)).toFixed(2)}%)`);

const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log('top quantized colors (bucket mid, count):');
for (const [k, n] of top) {
  const r = ((k >> 8) & 15) * 16 + 8, g = ((k >> 4) & 15) * 16 + 8, b = (k & 15) * 16 + 8;
  const hex = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  console.log(`  ${hex}  ${n}`);
}

// separable 5x5 min-filter erosion of red mask -> keeps only THICK red (city boundary)
function erode5(src) {
  const tmp = new Uint8Array(W * H), dst = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 1;
    for (let d = -2; d <= 2; d++) { const xx = x + d; if (xx < 0 || xx >= W || !src[y * W + xx]) { v = 0; break; } }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 1;
    for (let d = -2; d <= 2; d++) { const yy = y + d; if (yy < 0 || yy >= H || !tmp[yy * W + x]) { v = 0; break; } }
    dst[y * W + x] = v;
  }
  return dst;
}
const redThick = erode5(red);

function saveMaskPng(file, mask) {
  const step = Math.max(1, Math.round(W / 1400));
  const dw = Math.ceil(W / step), dh = Math.ceil(H / step);
  const out = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const v = mask[Math.min(y * step, H - 1) * W + Math.min(x * step, W - 1)] ? 255 : 0;
    const i = (y * dw + x) * 4;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT, file), PNG.sync.write(out));
}
saveMaskPng('red-mask.png', red);
saveMaskPng('yellow-mask.png', yellow);
saveMaskPng('red-thick.png', redThick);
console.log('debug masks written to', OUT);
