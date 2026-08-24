'use strict';
/* 07-namecrops.js — tight crops of each region's own red MZ label:
 * red pixels >=9px inside the region (interior cross test) -> bbox -> crop.
 * Writes debug/names-*.png contact sheets (2x4 cells). */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { loadScan, classify, dilate, connectedComponents } = require('./common');
const { drawText } = require('./draw');

const G = f => path.join(__dirname, '..', f);
const { W, H, data } = loadScan();
const { red, yellow } = classify(data, W, H);
const redDil = dilate(red, W, H, 2);
const area = new Uint8Array(W * H);
for (let i = 0; i < area.length; i++) area[i] = yellow[i] && !redDil[i] ? 1 : 0;
const { labels, regions } = connectedComponents(area, W, H, 4000);

const CELL_W = 560, CELL_H = 210, COLS = 2, ROWS = 4, PER = COLS * ROWS;
const SW = COLS * CELL_W, SH = ROWS * CELL_H;
let sheet = null, si = 0, cell = 0;
const newSheet = () => { sheet = new PNG({ width: SW, height: SH }); };
const flush = () => { fs.writeFileSync(G(`debug/names-${++si}.png`), PNG.sync.write(sheet)); };
newSheet();

// (cross-test approach removed)
// Red mask CCs: boundary lines = one huge component; MZ labels = small
// isolated components. Assign each small component to a region by majority
// of the surrounding yellow labels, then take the union bbox per region.
const { labels: rlab, regions: rregs } = connectedComponents(red, W, H, 1);
const acc = new Map(); // region id -> {minX,minY,maxX,maxY,n}
for (const c of rregs) {
  if (c.npix < 150 || c.npix > 25000) continue; // skip line network & specks
  const tally = new Map();
  const offs = [];
  for (let dy = -8; dy <= 8; dy += 4) for (let dx = -8; dx <= 8; dx += 4) offs.push([dx, dy]);
  for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) {
    if (rlab[y * W + x] !== c.id) continue;
    // sample surrounding yellow (the glyph pixels themselves are red => labels 0)
    for (const [dx, dy] of offs) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
      const id = labels[yy * W + xx];
      if (id) tally.set(id, (tally.get(id) || 0) + 1);
    }
  }
  let bestId = 0, bestN = 0, tot = 0;
  for (const [id, n] of tally) { tot += n; if (n > bestN) { bestN = n; bestId = id; } }
  if (!bestId || bestN < 0.6 * tot) continue;
  let a = acc.get(bestId);
  if (!a) { a = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, n: 0 }; acc.set(bestId, a); }
  a.n += c.npix;
  if (c.minX < a.minX) a.minX = c.minX; if (c.maxX > a.maxX) a.maxX = c.maxX;
  if (c.minY < a.minY) a.minY = c.minY; if (c.maxY > a.maxY) a.maxY = c.maxY;
}
for (const r of regions.filter(r => r.cy <= 6600).sort((a, b) => a.id - b.id)) {
  const a = acc.get(r.id);
  let x0, y0, x1, y1;
  if (a && a.n > 120) { x0 = a.minX; y0 = a.minY; x1 = a.maxX; y1 = a.maxY; }
  else {
    x0 = Math.round(r.cx - 260); y0 = Math.round(r.cy - 70);
    x1 = Math.round(r.cx + 260); y1 = Math.round(r.cy + 70);
    console.log(`region ${r.id}: no label component (${a ? a.n : 0}px), centroid crop`);
  }
  const pad = 22;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const s = Math.min(CELL_W / cw, CELL_H / ch, 2);
  const dw = Math.round(cw * s), dh = Math.round(ch * s);
  const dx0 = (cell % COLS) * CELL_W + ((CELL_W - dw) >> 1);
  const dy0 = ((cell / COLS) | 0) * CELL_H + ((CELL_H - dh) >> 1);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx = x0 + Math.min(cw - 1, Math.round(x / s));
    const sy = y0 + Math.min(ch - 1, Math.round(y / s));
    const s4 = (sy * W + sx) * 4, d4 = ((dy0 + y) * SW + dx0 + x) * 4;
    sheet.data[d4] = data[s4]; sheet.data[d4 + 1] = data[s4 + 1];
    sheet.data[d4 + 2] = data[s4 + 2]; sheet.data[d4 + 3] = 255;
  }
  for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
    drawText(sheet.data, SW, SH, '#' + r.id, ox + (cell % COLS) * CELL_W + 4, oy + ((cell / COLS) | 0) * CELL_H + 4, 2, [0, 0, 0]);
  drawText(sheet.data, SW, SH, '#' + r.id, (cell % COLS) * CELL_W + 4, ((cell / COLS) | 0) * CELL_H + 4, 2, [255, 255, 0]);
  if (++cell === PER) { flush(); newSheet(); cell = 0; }
}
if (cell > 0) flush();
console.log(`wrote ${si} name sheets -> debug/names-*.png`);
