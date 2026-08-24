'use strict';
/* common.js — scan loading, pixel classification, morphology, connected components. */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function loadScan() {
  const p = path.join(__dirname, '..', 'pdf-pages', 'page-1.png');
  const png = PNG.sync.read(fs.readFileSync(p));
  return { W: png.width, H: png.height, data: png.data };
}

/* red = boundary lines / labels; yellow = MZ fill; red wins over yellow. */
function classify(data, W, H) {
  const red = new Uint8Array(W * H);
  const yellow = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 110 && r - g > 45 && r - b > 45) red[y * W + x] = 1;
      else if (r > 130 && g > 115 && r - b > 25 && g - b > 15 && r - g < 60) yellow[y * W + x] = 1;
    }
  }
  return { red, yellow };
}

function erode(src, W, H, r) {
  const tmp = new Uint8Array(W * H), dst = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 1;
    for (let d = -r; d <= r; d++) { const xx = x + d; if (xx < 0 || xx >= W || !src[y * W + xx]) { v = 0; break; } }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 1;
    for (let d = -r; d <= r; d++) { const yy = y + d; if (yy < 0 || yy >= H || !tmp[yy * W + x]) { v = 0; break; } }
    dst[y * W + x] = v;
  }
  return dst;
}

function dilate(src, W, H, r) {
  const tmp = new Uint8Array(W * H), dst = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < W && src[y * W + xx]) { v = 1; break; } }
    tmp[y * W + x] = v;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < H && tmp[yy * W + x]) { v = 1; break; } }
    dst[y * W + x] = v;
  }
  return dst;
}

/* 4-connected labeling; compact ids 1..n + per-region stats. */
function connectedComponents(mask, W, H, minSize) {
  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const raw = [];
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    next++;
    let sp = 0, npix = 0, minX = W, maxX = 0, minY = H, maxY = 0, sx = 0, sy = 0;
    stack[sp++] = start; labels[start] = next;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      npix++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !labels[p - W]) { labels[p - W] = next; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !labels[p + W]) { labels[p + W] = next; stack[sp++] = p + W; }
    }
    raw.push({ id: next, npix, cx: sx / npix, cy: sy / npix, minX, maxX, minY, maxY });
  }
  const kept = raw.filter(r => r.npix >= minSize).sort((a, b) => a.id - b.id);
  const remap = new Int32Array(next + 1);
  kept.forEach((r, k) => { remap[r.id] = k + 1; r.id = k + 1; });
  for (let i = 0; i < labels.length; i++) if (labels[i]) labels[i] = remap[labels[i]];
  return { labels, regions: kept };
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255].map(Math.round);
}

/* downsample full-res painter to <=maxW wide PNG; sampleFn(x,y)->[r,g,b] */
function saveDebugPng(file, W, H, sampleFn, maxW = 1400) {
  const step = Math.max(1, Math.ceil(W / maxW));
  const dw = Math.ceil(W / step), dh = Math.ceil(H / step);
  const out = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const c = sampleFn(Math.min(x * step, W - 1), Math.min(y * step, H - 1));
    const i = (y * dw + x) * 4;
    out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2]; out.data[i + 3] = 255;
  }
  fs.writeFileSync(path.join(__dirname, '..', 'debug', file), PNG.sync.write(out));
  return { step, dw, dh };
}

module.exports = { loadScan, classify, erode, dilate, connectedComponents, hsvToRgb, saveDebugPng, PNG };
