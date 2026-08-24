'use strict';
/* match-places.js — for each MZ region centroid, list OSM place nodes within
 * a radius, to cross-check label transcriptions geographically. */
const fs = require('fs');
const path = require('path');
const G = f => path.join(__dirname, '..', f);
const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
const { T, KX, KY, lon0, lat0 } = tr;
const regions = JSON.parse(fs.readFileSync(G('debug/regions.json'), 'utf8')).regions.filter(r => r.cy <= 6600);
const places = JSON.parse(fs.readFileSync(G('osm/places.json'), 'utf8')).elements;
const toWorld = (x, y) => [lon0 + (T.a * x + T.b * y + T.c) / KX, lat0 + (T.d * x + T.e * y + T.f) / KY];
const distM = (la1, lo1, la2, lo2) => {
  const mx = 111319.49 * Math.cos(((la1 + la2) / 2) * Math.PI / 180);
  return Math.hypot((lo1 - lo2) * mx, (la1 - la2) * 110574.39);
};
const R = 3500;
for (const g of regions.sort((a, b) => a.id - b.id)) {
  const [lon, lat] = toWorld(g.cx, g.cy);
  const near = places
    .map(p => ({ n: p.tags['name:sr'] || p.tags.name, t: p.tags.place, d: distM(lat, lon, p.lat, p.lon) }))
    .filter(p => p.d <= R)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  console.log(`#${String(g.id).padStart(2)} (${lon.toFixed(4)},${lat.toFixed(4)}) ${Math.round(g.npix / 1000)}k :: ` +
    (near.length ? near.map(p => `${p.n}[${p.t},${Math.round(p.d)}m]`).join('  ') : '(nothing within 3.5km)'));
}
