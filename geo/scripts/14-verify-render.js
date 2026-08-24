'use strict';
// 14-verify-render.js — draw the final MZ polygons over the warped scan overlay
// (debug/overlay.jpg) and save tiles for visual boundary conformance checks:
// cyan = hand-drawn core, orange = traced rural. Labels at polygon centroids.
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const G = f => path.join(__dirname, '..', f);

(async () => {
  const fc = JSON.parse(fs.readFileSync(G('banja-luka-mz-final.geojson'), 'utf8'));
  const ob = JSON.parse(fs.readFileSync(G('debug/overlay-bounds.json'), 'utf8'));
  const im = await Jimp.read(G('debug/overlay.jpg'));
  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);
  const px = lon => (lon - ob.west) / (ob.east - ob.west) * ob.width;
  const py = lat => (ob.north - lat) / (ob.north - ob.south) * ob.height;
  const CYAN = Jimp.rgbaToInt(0, 229, 255, 255);
  const ORANGE = Jimp.rgbaToInt(255, 120, 0, 255);

  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0];
    const col = f.properties.source === 'manual-digitized' ? CYAN : ORANGE;
    for (let i = 0; i < ring.length - 1; i++) {
      const x0 = px(ring[i][0]), y0 = py(ring[i][1]);
      const x1 = px(ring[i + 1][0]), y1 = py(ring[i + 1][1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let s = 0; s <= steps; s++) {
        const X = Math.round(x0 + (x1 - x0) * s / steps);
        const Y = Math.round(y0 + (y1 - y0) * s / steps);
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) {
          if (X + dx >= 0 && Y + dy >= 0 && X + dx < ob.width && Y + dy < ob.height) {
            im.setPixelColor(col, X + dx, Y + dy);
          }
        }
      }
    }
  }

  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const f2 = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      a += f2; cx += (ring[i][0] + ring[i + 1][0]) * f2; cy += (ring[i][1] + ring[i + 1][1]) * f2;
    }
    if (Math.abs(a) > 1e-12) { cx /= 3 * a; cy /= 3 * a; }
    else { const m = ring[Math.floor(ring.length / 2)]; cx = (ring[0][0] + m[0]) / 2; cy = (ring[0][1] + m[1]) / 2; }
    const tx = Math.max(0, Math.min(ob.width - 60, Math.round(px(cx))));
    const ty = Math.max(12, Math.min(ob.height - 6, Math.round(py(cy))));
    const w = Math.min(ob.width - tx, Jimp.measureText(font, f.properties.name) + 4);
    im.scan(tx - 2 < 0 ? 0 : tx - 2, ty - 2, w, 18, function (x, y, idx) {
      const d = this.bitmap.data;
      d[idx] = 255; d[idx + 1] = 255; d[idx + 2] = 255; d[idx + 3] = 210;
    });
    await im.print(font, tx, ty, f.properties.name);
  }

  const tw = Math.ceil(ob.width / 2), th = Math.ceil(ob.height / 3);
  let n = 0;
  for (let ty0 = 0; ty0 < 3; ty0++) {
    for (let tx0 = 0; tx0 < 2; tx0++) {
      n++;
      const c = im.clone().crop(tx0 * tw, ty0 * th,
        Math.min(tw, ob.width - tx0 * tw), Math.min(th, ob.height - ty0 * th));
      if (c.bitmap.width > 1150) c.resize(1150, Jimp.AUTO);
      await c.quality(62).writeAsync(G(`debug/final-tile-${n}.jpg`));
      console.log(`tile ${n} (${tx0},${ty0}): ${c.bitmap.width}x${c.bitmap.height}`);
    }
  }
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
