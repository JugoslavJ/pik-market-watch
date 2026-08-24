'use strict';
/* 11-assign.js — assign red label components to MZ regions by dilation
 * overlap with the yellow component map, then write:
 *   debug/label-assign.json   { regionId: [ {bbox,npix,words} ] }
 *   debug/la-N.png/jpg        tight per-region label crops (2x4 sheets)
 * Unlike 07-namecrops (per-pixel ring votes), this dilates each whole label
 * component and picks the region with the largest overlap — robust for labels
 * straddling borders in dense urban fabric. */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { loadScan, classify, dilate, connectedComponents } = require('./common');
const { drawText } = require('./draw');
const G = f => path.join(__dirname, '..', f);

(async () => {
  const { data, W, H } = loadScan();
  const { red, yellow } = classify(data, W, H);
  const redDil = dilate(red, W, H, 2);
  const area = new Uint8Array(W * H);
  for (let i = 0; i < area.length; i++) area[i] = yellow[i] && !redDil[i] ? 1 : 0;
  const { labels, regions } = connectedComponents(area, W, H, 4000);
  const regionById = new Map(regions.map(r => [r.id, r]));
  const validRegion = id => id && id !== 52 && regionById.has(id);

  // red components = candidate label glyphs/words
  const { labels: rl, regions: rregs } = connectedComponents(red, W, H, 120);
  const DIL = 9;
  const assign = [];
  for (const c of rregs) {
    if (c.cy > 6600) continue; // legend area
    if (c.npix > 25000) continue; // boundary network / big fragments, not labels
    if (c.maxY - c.minY > 90 || c.maxX - c.minX > 720) continue; // labels are compact
    const x0 = Math.max(0, c.minX - DIL), y0 = Math.max(0, c.minY - DIL);
    const x1 = Math.min(W - 1, c.maxX + DIL), y1 = Math.min(H - 1, c.maxY + DIL);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // local mask + separable dilation within the bbox window
    const m = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (rl[(y0 + y) * W + (x0 + x)] === c.id) m[y * bw + x] = 1;
    }
    const dx = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      let acc = 0;
      for (let x = 0; x < bw; x++) {
        if (m[y * bw + x]) acc = DIL + 1;
        else if (acc > 0) acc--;
        if (acc > 0) dx[y * bw + x] = 1;
      }
      acc = 0;
      for (let x = bw - 1; x >= 0; x--) {
        if (m[y * bw + x]) acc = DIL + 1;
        else if (acc > 0) acc--;
        if (acc > 0) dx[y * bw + x] = 1;
      }
    }
    const dxy = new Uint8Array(bw * bh);
    for (let x = 0; x < bw; x++) {
      let acc = 0;
      for (let y = 0; y < bh; y++) {
        if (dx[y * bw + x]) acc = DIL + 1;
        else if (acc > 0) acc--;
        if (acc > 0) dxy[y * bw + x] = 1;
      }
      acc = 0;
      for (let y = bh - 1; y >= 0; y--) {
        if (dx[y * bw + x]) acc = DIL + 1;
        else if (acc > 0) acc--;
        if (acc > 0) dxy[y * bw + x] = 1;
      }
    }
    const votes = new Map();
    let tot = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!dxy[y * bw + x]) continue;
      const lid = labels[(y0 + y) * W + (x0 + x)];
      if (!validRegion(lid)) continue;
      votes.set(lid, (votes.get(lid) || 0) + 1);
      tot++;
    }
    if (!tot) continue;
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    assign.push({
      comp: c.id, region: best[0], share: best[1] / tot, npix: c.npix,
      minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY,
      cx: c.cx, cy: c.cy,
    });
  }
  // group by region; merge components whose bboxes are close (words of one label)
  const byRegion = new Map();
  for (const a of assign) {
    if (a.share < 0.55) continue; // ambiguous straddler
    if (!byRegion.has(a.region)) byRegion.set(a.region, []);
    byRegion.get(a.region).push(a);
  }
  const out = {};
  const crops = [];
  for (const [rid, comps] of byRegion) {
    comps.sort((a, b) => a.minX - b.minX);
    // merge bboxes with gap <= 40px (inter-word space)
    const merged = [];
    for (const c of comps) {
      const m = merged[merged.length - 1];
      if (m && c.minX - m.maxX <= 40 && !(c.minY > m.maxY + 30 || c.maxY < m.minY - 30)) {
        m.minX = Math.min(m.minX, c.minX); m.maxX = Math.max(m.maxX, c.maxX);
        m.minY = Math.min(m.minY, c.minY); m.maxY = Math.max(m.maxY, c.maxY);
        m.npix += c.npix;
      } else merged.push({ ...c });
    }
    out[rid] = merged.map(m => ({ npix: m.npix, bbox: [m.minX, m.minY, m.maxX, m.maxY], share: +m.share.toFixed(2) }));
    for (const m of merged) crops.push({ rid, ...m });
  }
  fs.writeFileSync(G('debug/label-assign.json'), JSON.stringify(out, null, 1));
  console.log(`regions with labels: ${Object.keys(out).length}; label groups: ${crops.length}`);
  const noLabel = [...regionById.keys()].filter(id => id !== 52 && !out[id]);
  console.log('regions without assigned label:', noLabel.join(', '));

  // contact sheets of tight crops (flat classification render, 2 columns)
  crops.sort((a, b) => a.rid - b.rid || a.minX - b.minX);
  const CW = 500, CH = 110, PAD = 6, LH = 24;
  const sheets = [];
  for (let i = 0; i < crops.length; i += 12) sheets.push(crops.slice(i, i + 12));
  for (let s = 0; s < sheets.length; s++) {
    const group = sheets[s];
    const SW = CW * 2 + PAD * 3, SH = (CH + LH) * 6 + PAD;
    const sheet = new Jimp(SW, SH, 0x000000ff);
    for (let c = 0; c < group.length; c++) {
      const g = group[c];
      const pad2 = 26;
      const x0 = Math.max(0, g.minX - pad2), y0 = Math.max(0, g.minY - pad2);
      const x1 = Math.min(W - 1, g.maxX + pad2), y1 = Math.min(H - 1, g.maxY + pad2);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const cell = new Jimp(w, h);
      const cd = cell.bitmap.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y0 + y) * W + (x0 + x), o = (y * w + x) * 4;
        if (red[i]) { cd[o] = 200; cd[o + 1] = 0; cd[o + 2] = 0; }
        else {
          const lum = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
          const v = lum < 90 ? 120 : 255;
          cd[o] = v; cd[o + 1] = v; cd[o + 2] = v;
        }
        cd[o + 3] = 255;
      }
      const sc = Math.min(1, CW / w, CH / h);
      if (sc < 1) cell.resize(Math.max(1, Math.round(w * sc)), Math.max(1, Math.round(h * sc)), Jimp.RESIZE_NEAREST_NEIGHBOR);
      const col = c % 2, row = (c / 2) | 0;
      const ox = PAD + col * (CW + PAD), oy = PAD + row * (CH + LH);
      sheet.composite(cell, ox + ((CW - cell.bitmap.width) >> 1), oy + LH + ((CH - cell.bitmap.height) >> 1));
      drawText(sheet.bitmap.data, SW, SH, `#${g.rid}`, ox + 4, oy + 4, 2, [255, 255, 0]);
    }
    const outp = G(`debug/la-${s + 1}.png`);
    await sheet.writeAsync(outp);
    console.log(`la-${s + 1}.png ${sheet.bitmap.width}x${sheet.bitmap.height} -> ${fs.statSync(outp).size} bytes`);
  }
})().catch(e => { console.error(e); process.exit(1); });
