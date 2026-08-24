'use strict';
/* 02-regions.js — segment MZs: connected components of yellow fill split by
 * (dilated) red boundary lines. Writes colored debug PNG with region ids and
 * debug/regions.json metadata. */
const fs = require('fs');
const path = require('path');
const { loadScan, classify, dilate, connectedComponents, hsvToRgb, saveDebugPng } = require('./common');
const { drawText } = require('./draw');

const { W, H, data } = loadScan();
const { red, yellow } = classify(data, W, H);

// close anti-aliasing halos around red lines so they fully separate regions
const redDil = dilate(red, W, H, 2);

const area = new Uint8Array(W * H);
for (let i = 0; i < area.length; i++) area[i] = yellow[i] && !redDil[i] ? 1 : 0;

const { labels, regions } = connectedComponents(area, W, H, 4000);
console.log(`regions >= 4000 px: ${regions.length}`);
regions.sort((a, b) => b.npix - a.npix);
console.log('  id      npix       cx       cy   bbox');
for (const r of regions) {
  console.log(
    String(r.id).padStart(4),
    String(r.npix).padStart(9),
    r.cx.toFixed(0).padStart(8),
    r.cy.toFixed(0).padStart(8),
    `[${r.minX},${r.minY} .. ${r.maxX},${r.maxY}]`
  );
}

fs.writeFileSync(
  path.join(__dirname, '..', 'debug', 'regions.json'),
  JSON.stringify({ W, H, regions }, null, 1)
);

// colored full-res composite + white id labels, then downsample
const rgb = Buffer.alloc(W * H * 4);
const pal = new Map();
for (const r of regions) pal.set(r.id, hsvToRgb((r.id * 47) % 360, 0.85, 0.95));
for (let i = 0, p = 0; i < labels.length; i++, p += 4) {
  const c = labels[i] ? pal.get(labels[i]) : [24, 24, 24];
  rgb[p] = c[0]; rgb[p + 1] = c[1]; rgb[p + 2] = c[2]; rgb[p + 3] = 255;
}
for (const r of regions) {
  const txt = '#' + r.id;
  const wpx = txt.length * 6 * 4;
  drawText(rgb, W, H, txt, Math.round(r.cx - wpx / 2), Math.round(r.cy - 14), 4, [255, 255, 255]);
}
saveDebugPng('regions.png', W, H, (x, y) => {
  const i = (y * W + x) * 4;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
});
console.log('wrote debug/regions.png + debug/regions.json');
