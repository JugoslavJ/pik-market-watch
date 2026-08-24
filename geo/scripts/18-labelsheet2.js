'use strict';
// 18-labelsheet2.js — high-res verification sheets for MZ name readings.
// 2x2 grid of centroid crops (500x300 native, ~1.1x upscale) per sheet.
// Usage: node 18-labelsheet2.js 1 4 5 6
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const G = f => path.join('C:/Users/Korisnik/repos/pik-market-watch/geo', f);

(async () => {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) { console.error('usage: node 18-labelsheet2.js <mz_id>...'); process.exit(1); }
  const mz = JSON.parse(fs.readFileSync(G('banja-luka-mz.geojson'), 'utf8'));
  const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
  const { T, KX, KY, lon0, lat0 } = tr;
  const det = T.a * T.e - T.b * T.d;
  const inv = (X, Y) => [
    (T.e * (X - T.c) - T.b * (Y - T.f)) / det,
    (-T.d * (X - T.c) + T.a * (Y - T.f)) / det,
  ];
  const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  const im = await Jimp.read(G('pdf-pages/page-1.png'));
  const CW = 550, CH = 330, CAP = 22;

  for (let s = 0; s < ids.length; s += 4) {
    const sheet = new Jimp(CW * 2, (CH + CAP) * 2);
    for (let k = 0; k < 4 && s + k < ids.length; k++) {
      const id = ids[s + k];
      const feat = mz.features.find(f => f.properties.mz_id === id);
      if (!feat) continue;
      const ring = feat.geometry.coordinates[0];
      let a = 0, cx = 0, cy = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const f2 = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        a += f2; cx += (ring[i][0] + ring[i + 1][0]) * f2; cy += (ring[i][1] + ring[i + 1][1]) * f2;
      }
      cx /= 3 * a; cy /= 3 * a;
      const [px, py] = inv((cx - lon0) * KX, (cy - lat0) * KY);
      const ox = Math.max(0, Math.round(px) - 250), oy = Math.max(0, Math.round(py) - 150);
      const cell = im.clone().crop(ox, oy,
        Math.min(500, im.bitmap.width - ox), Math.min(300, im.bitmap.height - oy));
      cell.resize(CW, CH);
      const gx = (k % 2) * CW, gy = Math.floor(k / 2) * (CH + CAP);
      sheet.composite(cell, gx, gy + CAP);
      sheet.print(font, gx + 6, gy + 3, `mz ${id}`);
    }
    const out = `debug/labels2-${Math.floor(s / 4) + 1}.jpg`;
    await sheet.quality(80).writeAsync(G(out));
    console.log(`${out}: ids ${ids.slice(s, s + 4).join(', ')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
