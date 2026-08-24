'use strict';
// 16-cropat.js — crop the original scan around a lon/lat point or an MZ id's
// centroid. Usage: node 16-cropat.js 17.24 44.75   |   node 16-cropat.js 2
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const G = f => path.join('C:/Users/Korisnik/repos/pik-market-watch/geo', f);
const arg = Number(process.argv[2]);
(async () => {
  const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
  const { T, KX, KY, lon0, lat0 } = tr;
  const det = T.a * T.e - T.b * T.d;
  const inv = (X, Y) => [
    (T.e * (X - T.c) - T.b * (Y - T.f)) / det,
    (-T.d * (X - T.c) + T.a * (Y - T.f)) / det,
  ];
  let lon, lat;
  if (arg > 0 && arg < 100 && !process.argv[3]) {
    const mz = JSON.parse(fs.readFileSync(G('banja-luka-mz.geojson'), 'utf8'));
    const ring = mz.features.find(f => f.properties.mz_id === arg).geometry.coordinates[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const f2 = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      a += f2; cx += (ring[i][0] + ring[i + 1][0]) * f2; cy += (ring[i][1] + ring[i + 1][1]) * f2;
    }
    lon = cx / (3 * a); lat = cy / (3 * a);
    console.log(`mz ${arg} centroid (${lon.toFixed(4)}, ${lat.toFixed(4)})`);
  } else {
    lon = arg; lat = Number(process.argv[3]);
  }
  const im = await Jimp.read(G('pdf-pages/page-1.png'));
  const [px, py] = inv((lon - lon0) * KX, (lat - lat0) * KY);
  const cx = Math.max(0, Math.round(px) - 220), cy = Math.max(0, Math.round(py) - 130);
  const c = im.clone().crop(cx, cy, 440, 260);
  if (c.bitmap.width < 900) c.resize(900, Jimp.AUTO);
  await c.quality(82).writeAsync(G('debug/cropat.jpg'));
  console.log(`scan px (${px.toFixed(0)}, ${py.toFixed(0)}) -> debug/cropat.jpg`);
})().catch(e => { console.error(e); process.exit(1); });
