'use strict';
/* check-fit.js — honest registration residual: for each resampled OSM boundary
 * point, distance to the nearest transformed traced-ring vertex.
 * Independent of the ICP's own bookkeeping. */
const fs = require('fs');
const path = require('path');
const G = f => path.join(__dirname, '..', f);
const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
const { T, KX, KY, lon0, lat0 } = tr;
const px = JSON.parse(fs.readFileSync(G('debug/regions-pixel.json'), 'utf8'));

// transformed ring vertices (meters, local)
const A = [];
for (const r of px.regions) {
  if (r.cy > 6600) continue;
  for (const [x, y] of r.ring) A.push([T.a * x + T.b * y + T.c, T.d * x + T.e * y + T.f]);
}
console.log('ring verts:', A.length);

// OSM boundary points (meters, local), resampled ~60 m
const rel = JSON.parse(fs.readFileSync(G('osm/grad-banjaluka.json'), 'utf8')).elements[0];
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
console.log('osm pts:', B.length);

// grid hash, integer keys — bucket actual points
const CELL = 400;
const buckets = new Map();
A.forEach(p => {
  const k = Math.floor(p[0] / CELL) * 100000 + Math.floor(p[1] / CELL);
  (buckets.get(k) || buckets.set(k, []).get(k)).push(p);
});
function nnDist(q) {
  const fx = Math.floor(q[0] / CELL), fy = Math.floor(q[1] / CELL);
  for (let r = 1; r < 300; r++) {
    let bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const a = buckets.get((fx + dx) * 100000 + (fy + dy));
      if (!a) continue;
      for (const p of a) { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < bd) bd = d; }
    }
    if (bd < Infinity && r > 1) return Math.sqrt(bd); // ring r complete-ish
    if (bd < Infinity && r === 1) {
      // one more ring to be safe about closer points just outside
      let bd2 = bd;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const a = buckets.get((fx + dx) * 100000 + (fy + dy));
        if (!a) continue;
        for (const p of a) { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < bd2) bd2 = d; }
      }
      return Math.sqrt(bd2);
    }
  }
  return Infinity;
}
const ds = B.map(nnDist).sort((a, b) => a - b);
const q = f => ds[Math.min(ds.length - 1, (ds.length * f) | 0)];
console.log(`OSM boundary -> transformed rings: mean ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(0)} m, ` +
  `median ${q(0.5).toFixed(0)} m, p90 ${q(0.9).toFixed(0)} m, p99 ${q(0.99).toFixed(0)} m, max ${ds[ds.length - 1].toFixed(0)} m`);
