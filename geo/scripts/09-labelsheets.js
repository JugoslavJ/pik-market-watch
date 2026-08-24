'use strict';
/* 09-labelsheets.js — contact sheets of centroid-centered windows rendered
 * from the classification masks (red boundary/label pixels -> red, yellow MZ
 * fill -> pale yellow, dark map ink -> black, rest -> white). Flat colors
 * compress far below the viewer limit while keeping MZ labels crisp.
 * 8 cells (2x4) per sheet, ascending region id. Output: debug/ls-N.jpg */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { loadScan, classify } = require('./common');
const { drawText } = require('./draw');
const G = f => path.join(__dirname, '..', f);

const CELL_W = 512, CELL_H = 366;
const WIN_W = 1000, WIN_H = 720;
const PAD = 6, LABEL_H = 26;

(async () => {
  const { data, W, H } = loadScan();
  const { red } = classify(data, W, H);
  const regions = JSON.parse(fs.readFileSync(G('debug/regions.json'), 'utf8'))
    .regions.filter(r => r.cy <= 6600).sort((a, b) => a.id - b.id);

  const sheets = [];
  for (let i = 0; i < regions.length; i += 8) sheets.push(regions.slice(i, i + 8));

  const renderSheet = (group, scale) => {
    const CW = Math.round(CELL_W * scale), CH = Math.round(CELL_H * scale);
    const SW = CW * 2 + PAD * 3, SH = (CH + LABEL_H) * 4 + PAD * 5;
    const sheet = new Jimp(SW, SH, 0x000000ff);
    for (let c = 0; c < group.length; c++) {
      const r = group[c];
      const col = c % 2, row = (c / 2) | 0;
      const x0 = Math.max(0, Math.min(W - WIN_W, Math.round(r.cx - WIN_W / 2)));
      const y0 = Math.max(0, Math.min(H - WIN_H, Math.round(r.cy - WIN_H / 2)));
      const win = new Jimp(WIN_W, WIN_H); // fresh buffer each cell — resize mutates it
      const wd = win.bitmap.data;
      for (let y = 0; y < WIN_H; y++) {
        const rowBase = (y0 + y) * W + x0;
        for (let x = 0; x < WIN_W; x++) {
          const i = rowBase + x, o = (y * WIN_W + x) * 4;
          if (red[i]) { wd[o] = 200; wd[o + 1] = 0; wd[o + 2] = 0; }
          else {
            const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
            const v = lum < 90 ? 40 : 255;
            wd[o] = v; wd[o + 1] = v; wd[o + 2] = v;
          }
          wd[o + 3] = 255;
        }
      }
      win.resize(CW, CH, Jimp.RESIZE_NEAREST_NEIGHBOR);
      const ox = PAD + col * (CW + PAD), oy = PAD + row * (CH + LABEL_H + PAD);
      sheet.composite(win, ox, oy + LABEL_H);
      drawText(sheet.bitmap.data, SW, SH, `#${r.id}`, ox + 4, oy + 6, 2, [255, 255, 0]);
    }
    return sheet;
  };

  for (let s = 0; s < sheets.length; s++) {
    let scale = 1;
    let sheet = renderSheet(sheets[s], scale);
    const out = G(`debug/ls-${s + 1}.png`);
    await sheet.writeAsync(out);
    let sz = fs.statSync(out).size;
    while (sz > 155000 && scale > 0.6) {
      scale -= 0.12;
      sheet = renderSheet(sheets[s], scale);
      await sheet.writeAsync(out);
      sz = fs.statSync(out).size;
      console.log(`  retry ls-${s + 1} at scale ${scale.toFixed(2)} -> ${sz} bytes`);
    }
    console.log(`ls-${s + 1}.png (${sheet.bitmap.width}x${sheet.bitmap.height}) -> ${sz} bytes`);
  }
})().catch(e => { console.error(e); process.exit(1); });
