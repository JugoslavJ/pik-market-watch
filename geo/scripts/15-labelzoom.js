'use strict';
// 15-labelzoom.js — high-res crops of the red MZ labels for regions whose
// spelling needs a second look. Crops the original scan around the largest
// label group from debug/label-assign.json (scan-pixel bboxes).
// Usage: node 15-labelzoom.js 38 47 49
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const G = f => path.join(__dirname, '..', f);

const IDS = process.argv.slice(2).map(Number).filter(Boolean);

(async () => {
  const la = JSON.parse(fs.readFileSync(G('debug/label-assign.json'), 'utf8'));
  const mz = JSON.parse(fs.readFileSync(G('banja-luka-mz.geojson'), 'utf8'));
  const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
  const { T, KX, KY, lon0, lat0 } = tr;
  const det = T.a * T.e - T.b * T.d;
  const inv = (X, Y) => [
    (T.e * (X - T.c) - T.b * (Y - T.f)) / det,
    (-T.d * (X - T.c) + T.a * (Y - T.f)) / det,
  ];
  const im = await Jimp.read(G('pdf-pages/page-1.png'));
  for (const id of (IDS.length ? IDS : [38, 47, 49])) {
    let box = null, tag = '';
    const groups = la[String(id)] || [];
    if (groups.length) {
      const g = groups.reduce((a, b) => (b.npix > a.npix ? b : a));
      box = g.bbox;
      tag = `label npix ${g.npix}`;
    } else { // fallback: crop around the region centroid via the georef affine
      const feat = mz.features.find(f => f.properties.mz_id === id);
      if (!feat) { console.log(`#${id}: no label groups, no region`); continue; }
      const ring = feat.geometry.coordinates[0];
      let a = 0, cx = 0, cy = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const f2 = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        a += f2; cx += (ring[i][0] + ring[i + 1][0]) * f2; cy += (ring[i][1] + ring[i + 1][1]) * f2;
      }
      if (Math.abs(a) < 1e-12) { console.log(`#${id}: degenerate ring`); continue; }
      cx /= 3 * a; cy /= 3 * a;
      const [px, py] = inv((cx - lon0) * KX, (cy - lat0) * KY);
      box = [Math.round(px - 170), Math.round(py - 70), Math.round(px + 170), Math.round(py + 70)];
      tag = `centroid fallback (${cx.toFixed(4)}, ${cy.toFixed(4)})`;
    }
    const [x0, y0, x1, y1] = box;
    const m = 70;
    const cx = Math.max(0, x0 - m), cy = Math.max(0, y0 - m);
    const cw = Math.min(im.bitmap.width - cx, x1 - x0 + 2 * m);
    const ch = Math.min(im.bitmap.height - cy, y1 - y0 + 2 * m);
    const c = im.clone().crop(cx, cy, cw, ch);
    if (c.bitmap.width < 900) c.resize(900, Jimp.AUTO);
    await c.quality(82).writeAsync(G(`debug/labelzoom-${id}.jpg`));
    console.log(`#${id}: ${tag} bbox [${box}] -> debug/labelzoom-${id}.jpg`);
  }
})().catch(e => { console.error(e); process.exit(1); });
