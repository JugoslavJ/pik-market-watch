'use strict';
/* 08-centroidcrops.js — contact sheets of centroid-centered label crops.
 * The 07-namecrops glyph->region ring heuristic misassigns labels near
 * borders (e.g. region 18 got a neighbour's label), so these crops are
 * centered on each yellow component's centroid instead — always inside the
 * region. 8 cells (2x4) per sheet, ascending region id, "#id" drawn per cell.
 * Output: debug/cc-N.png + .jpg (kept < ~160 KB for the viewer). */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { loadScan } = require('./common');
const G = f => path.join(__dirname, '..', f);

const CELL_W = 660, CELL_H = 480;      // cell size in sheet
const WIN_W = 1100, WIN_H = 800;       // full-res crop window around centroid
const PAD = 6, LABEL_H = 26;

(async () => {
  const { data, W, H } = loadScan();
  const regions = JSON.parse(fs.readFileSync(G('debug/regions.json'), 'utf8'))
    .regions.filter(r => r.cy <= 6600)
    .sort((a, b) => a.id - b.id);
  console.log(`regions: ${regions.length}`);

  const sheets = [];
  for (let i = 0; i < regions.length; i += 8) sheets.push(regions.slice(i, i + 8));

  const { drawText } = require('./draw');
  for (let s = 0; s < sheets.length; s++) {
    const group = sheets[s];
    const SW = CELL_W * 2 + PAD * 3, SH = (CELL_H + LABEL_H) * 4 + PAD * 5;
    const sheet = new Jimp(SW, SH, 0x000000ff);
    for (let c = 0; c < group.length; c++) {
      const r = group[c];
      const col = c % 2, row = (c / 2) | 0;
      const x0 = Math.max(0, Math.min(W - WIN_W, Math.round(r.cx - WIN_W / 2)));
      const y0 = Math.max(0, Math.min(H - WIN_H, Math.round(r.cy - WIN_H / 2)));
      const cell = new Jimp(WIN_W, WIN_H);
      // blit from scan
      for (let y = 0; y < WIN_H; y++) {
        const src = ((y0 + y) * W + x0) * 4, dst = (y * WIN_W) * 4;
        cell.bitmap.data.set(data.subarray(src, src + WIN_W * 4), dst);
      }
      cell.resize(CELL_W, CELL_H);
      const ox = PAD + col * (CELL_W + PAD), oy = PAD + row * (CELL_H + LABEL_H + PAD);
      sheet.composite(cell, ox, oy + LABEL_H);
      drawText(sheet.bitmap.data, SW, SH, `#${r.id}`, ox + 4, oy + 6, 2, [255, 255, 0]);
    }
    const png = G(`debug/cc-${s + 1}.png`);
    await sheet.writeAsync(png);
    // jpg under viewer limit
    let q = 74, out = G(`debug/cc-${s + 1}.jpg`);
    for (;;) {
      await sheet.clone().quality(q).writeAsync(out);
      const sz = fs.statSync(out).size;
      console.log(`cc-${s + 1}.jpg q${q} -> ${sz} bytes`);
      if (sz <= 160000 || q <= 40) break;
      q -= 8;
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
