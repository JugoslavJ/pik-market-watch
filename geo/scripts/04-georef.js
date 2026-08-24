'use strict';
/* 04-georef.js — georeference: city outline = outer boundary of the union of
 * traced MZ regions (dilated 5px ≈ red boundary centerline); ICP-register it
 * against the OSM Grad Banja Luka admin boundary; apply affine to all rings;
 * write geo/banja-luka-mz.geojson + debug/transform.json. */
const fs = require('fs');
const path = require('path');
const { loadScan, classify, dilate, connectedComponents } = require('./common');
const { fitAffineICP, evalInit } = require('./geo-icp');

const G = f => path.join(__dirname, '..', f);
const { W, H, data } = loadScan();
const { red, yellow } = classify(data, W, H);
const redDil = dilate(red, W, H, 2);
const area = new Uint8Array(W * H);
for (let i = 0; i < area.length; i++) area[i] = yellow[i] && !redDil[i] ? 1 : 0;
const { labels, regions } = connectedComponents(area, W, H, 4000);
let legendId = 0;
for (const r of regions) if (r.cy > 6600) legendId = r.id;
const union = new Uint8Array(W * H);
for (let i = 0; i < labels.length; i++) if (labels[i] && labels[i] !== legendId) union[i] = 1;
const u5 = dilate(union, W, H, 5); // ≈ centerline of the thick red city boundary

// outer boundary of u5 via crack following (interior on right)
const W1 = W + 1;
const em = new Map();
const inside = (x, y) => x >= 0 && x < W && y >= 0 && y < H && u5[y * W + x];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!u5[y * W + x]) continue;
  const add = (fx, fy, tx, ty, dir) => {
    const k = fy * W1 + fx;
    let a = em.get(k); if (!a) { a = []; em.set(k, a); }
    a.push(ty * W1 + tx, dir);
  };
  if (!inside(x, y - 1)) add(x, y, x + 1, y, 0);
  if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
  if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
  if (!inside(x - 1, y)) add(x, y + 1, x, y, 3);
}
let startK = Infinity;
for (const k of em.keys()) if (k < startK) startK = k;
const outline = [];
{
  let cur = startK, dir = -1, guard = 0;
  do {
    const arr = em.get(cur);
    const prefs = dir === -1 ? [0, 1, 2, 3] : [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
    let next = -1, ndir = -1;
    for (const want of prefs) for (let i = 1; i < arr.length; i += 2) if (arr[i] === want) { next = arr[i - 1]; ndir = want; break; }
    if (next < 0) throw new Error('outline walk dead end');
    outline.push([cur % W1, (cur / W1) | 0]);
    dir = ndir; cur = next;
    if (++guard > em.size * 4 + 16) throw new Error('outline walk did not close');
  } while (cur !== startK);
}
const A = [];
for (let i = 0; i < outline.length; i += 3) A.push(outline[i]);
console.log(`union outline: ${outline.length} corners, ${A.length} ICP samples`);

const rel = JSON.parse(fs.readFileSync(G('osm/grad-banjaluka.json'), 'utf8')).elements[0];
const lons = [], lats = [];
for (const m of rel.members) if (m.type === 'way' && m.role === 'outer') for (const g of m.geometry) { lons.push(g.lon); lats.push(g.lat); }
const lon0 = Math.min(...lons), lat0 = Math.min(...lats);
const latC = (lat0 + Math.max(...lats)) / 2;
const KX = 111319.49079327358 * Math.cos(latC * Math.PI / 180);
const KY = 110574.38855777876;
const B = [];
for (const m of rel.members) {
  if (m.type !== 'way' || m.role !== 'outer') continue;
  let prev = null;
  for (const g of m.geometry) {
    const p = [(g.lon - lon0) * KX, (g.lat - lat0) * KY];
    if (prev) {
      const dx = p[0] - prev[0], dy = p[1] - prev[1];
      const n = Math.max(1, Math.round(Math.hypot(dx, dy) / 60));
      for (let i = 1; i <= n; i++) B.push([prev[0] + dx * i / n, prev[1] + dy * i / n]);
    } else B.push(p);
    prev = p;
  }
}
console.log(`OSM boundary points: ${B.length}`);

let init = null, bestRes = Infinity, bestDesc = '';
for (let deg = -2; deg <= 2.001; deg += 0.5) {
  for (const flipY of [false, true]) for (const flipX of [false, true]) {
    const e = evalInit(A, B, deg * Math.PI / 180, { flipY, flipX });
    const desc = `init ${deg >= 0 ? '+' : ''}${deg.toFixed(1)}deg flipY=${flipY ? 1 : 0} flipX=${flipX ? 1 : 0}`;
    console.log(`  ${desc} -> mean res ${e.meanRes.toFixed(0)} m`);
    if (e.meanRes < bestRes) { bestRes = e.meanRes; init = e.T; bestDesc = desc; }
  }
}
console.log(`best: ${bestDesc} (${bestRes.toFixed(0)} m)`);
const { T, stats } = fitAffineICP(A, B, init, { log: true });
const rot = Math.atan2(T.b, T.a) * 180 / Math.PI;
console.log(`ICP: inliers mean ${stats.mean.toFixed(1)} m, max ${stats.max.toFixed(1)} m (${stats.inliers} inliers)`);
console.log(`ICP all points: mean ${stats.all.mean.toFixed(1)} m, median ${stats.all.median.toFixed(1)} m, p90 ${stats.all.p90.toFixed(1)} m, max ${stats.all.max.toFixed(1)} m (${stats.all.n} pts)`);
console.log(`scale: ${(Math.hypot(T.a, T.d)).toFixed(2)} x ${(Math.hypot(T.b, T.e)).toFixed(2)} m/px, rotation ${rot.toFixed(3)}deg`);

const px = JSON.parse(fs.readFileSync(G('debug/regions-pixel.json'), 'utf8'));
let names = {};
try { names = JSON.parse(fs.readFileSync(path.join(__dirname, 'names.json'), 'utf8')); } catch { /* optional */ }
const feats = [];
for (const reg of px.regions) {
  if (reg.cy > 6600) continue; // legend swatch
  const ring = reg.ring.map(([x, y]) => {
    const X = T.a * x + T.b * y + T.c, Y = T.d * x + T.e * y + T.f;
    return [+(lon0 + X / KX).toFixed(6), +(lat0 + Y / KY).toFixed(6)];
  });
  if (ring.length > 2) {
    const f0 = ring[0], fl = ring[ring.length - 1];
    if (f0[0] === fl[0] && f0[1] === fl[1]) ring.pop();
  }
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  if (a2 < 0) ring.reverse(); // RFC 7946: exterior ring CCW
  ring.push([ring[0][0], ring[0][1]]);
  const nm = names[String(reg.id)];
  feats.push({
    type: 'Feature',
    properties: {
      mz_id: reg.id,
      name: nm || `MZ ${reg.id}`,
      source: 'trace: Prostorni plan grada Banja Luke, list 1-2 (Teritorija i granice NM i MZ)',
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
}
fs.writeFileSync(G('banja-luka-mz.geojson'), JSON.stringify({ type: 'FeatureCollection', features: feats }));
fs.writeFileSync(G('debug/transform.json'), JSON.stringify({ T, stats, KX, KY, lon0, lat0 }, null, 1));
console.log(`wrote geo/banja-luka-mz.geojson (${feats.length} features)`);
