'use strict';
/* 06-labels.js — contact sheets of per-region crops (with #id) for reading
 * the MZ name labels off the scan. Writes debug/labels-*.png */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { drawText } = require('./draw');

const G = f => path.join(__dirname, '..', f);
const page = PNG.sync.read(fs.readFileSync(G('pdf-pages/page-1.png')));
const W = page.width, H = page.height, data = page.data;
const px = JSON.parse(fs.readFileSync(G('debug/regions-pixel.json'), 'utf8'));
const regs = px.regions.filter(r => r.cy <= 6600).sort((a, b) => a.id - b.id);

const CELL_W = 640, CELL_H = 460, COLS = 2, ROWS = 3, PER = COLS * ROWS;
const SW = COLS * CELL_W, SH = ROWS * CELL_H;
let sheet = null, si = 0, cell = 0;
const newSheet = () => { sheet = new PNG({ width: SW, height: SH }); };
const flush = () => { fs.writeFileSync(G(`debug/labels-${++si}.png`), PNG.sync.write(sheet)); };
newSheet();
for (const r of regs) {
  if (cell === PER) { flush(); newSheet(); cell = 0; }
  const bb = r.bbox;
  const m = Math.round(0.12 * Math.max(bb[2] - bb[0], bb[3] - bb[1])) + 30;
  const x0 = Math.max(0, bb[0] - m), y0 = Math.max(0, bb[1] - m);
  const x1 = Math.min(W - 1, bb[2] + m), y1 = Math.min(H - 1, bb[3] + m);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const s = Math.min(CELL_W / cw, CELL_H / ch, 1);
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
  // id tag with black halo for readability
  for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
    drawText(sheet.data, SW, SH, '#' + r.id, ox + (cell % COLS) * CELL_W + 6, oy + ((cell / COLS) | 0) * CELL_H + 6, 3, [0, 0, 0]);
  drawText(sheet.data, SW, SH, '#' + r.id, (cell % COLS) * CELL_W + 6, ((cell / COLS) | 0) * CELL_H + 6, 3, [255, 255, 0]);
  cell++;
}
flush();
console.log(`wrote ${si} label sheets -> debug/labels-*.png (${regs.length} regions)`);
