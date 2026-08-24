'use strict';
/* 05-render.js — pixel-space registration check: grayscale scan + traced MZ
 * rings (red) + OSM city boundary mapped back through the inverse affine
 * (blue). Writes debug/check.png */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const G = f => path.join(__dirname, '..', f);
const page = PNG.sync.read(fs.readFileSync(G('pdf-pages/page-1.png')));
const W = page.width, H = page.height, pd = page.data;
const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
const { T, KX, KY, lon0, lat0 } = tr;
const px = JSON.parse(fs.readFileSync(G('debug/regions-pixel.json'), 'utf8'));
const rel = JSON.parse(fs.readFileSync(G('osm/grad-banjaluka.json'), 'utf8')).elements[0];

const step = Math.max(1, Math.ceil(W / 1400));
const dw = Math.ceil(W / step), dh = Math.ceil(H / step);
const cv = new PNG({ width: dw, height: dh });
for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
  const s = (Math.min(y * step, H - 1) * W + Math.min(x * step, W - 1)) * 4;
  const i = (y * dw + x) * 4;
  const g = ((pd[s] * 0.5 + pd[s + 1] * 0.5 + pd[s + 2] * 0.5) | 0) & 0xf0;
  cv.data[i] = g; cv.data[i + 1] = g; cv.data[i + 2] = g; cv.data[i + 3] = 255;
}
const plot = (x, y, c) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= dw || y < 0 || y >= dh) return;
  const i = (y * dw + x) * 4;
  cv.data[i] = c[0]; cv.data[i + 1] = c[1]; cv.data[i + 2] = c[2];
};
const line = (x0, y0, x1, y1, c) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) plot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, c);
};
const sc = p => [p[0] / step, p[1] / step];
// traced rings in red
for (const r of px.regions) {
  const ring = r.ring.map(sc);
  for (let i = 0; i < ring.length - 1; i++) line(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], [255, 40, 40]);
}
// OSM boundary via inverse affine, in blue
const det = T.a * T.e - T.b * T.d;
const toPx = (lon, lat) => {
  const X = (lon - lon0) * KX, Y = (lat - lat0) * KY;
  return [((T.e * (X - T.c) - T.b * (Y - T.f)) / det) / step, ((-T.d * (X - T.c) + T.a * (Y - T.f)) / det) / step];
};
for (const m of rel.members) {
  if (m.type !== 'way' || m.role !== 'outer') continue;
  let prev = null;
  for (const g of m.geometry) {
    const p = toPx(g.lon, g.lat);
    if (prev) line(prev[0], prev[1], p[0], p[1], [30, 80, 255]);
    prev = p;
  }
}
fs.writeFileSync(G('debug/check.png'), PNG.sync.write(cv));
console.log(`wrote debug/check.png (${dw}x${dh})`);
