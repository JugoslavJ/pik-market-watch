'use strict';
// merge.js — combine the hand-drawn city core (city-core.geojson, 19 polygons)
// with the auto-traced rural MZs (banja-luka-mz.geojson, 51 regions) into the
// final MZ set: geo/banja-luka-mz-final.geojson.
// Traced regions mostly inside a hand-drawn polygon are absorbed (reported).
// Output rings: closed, CCW (RFC 7946), 6 dp. Checks: pin containment,
// pairwise overlap sampling, spot pins, per-polygon areas.
const fs = require('fs');
const path = require('path');
const GEO = path.join(__dirname, '..');

const core = JSON.parse(fs.readFileSync(path.join(GEO, 'city-core.geojson'), 'utf8'));
const traced = JSON.parse(fs.readFileSync(path.join(GEO, 'banja-luka-mz.geojson'), 'utf8'));

// mz_id -> display name (map labels; PROGRESS §7 + debug/ls-*.png sheets,
// cross-checked against osm/places.json + Wikipedia where available)
const NAMES = {
  1: 'Šimani', 2: 'Verići', 3: 'Potkozarje', 4: 'Mišin Han', 5: 'Prijakovci',
  6: 'Piskavica', 7: 'Dragočaj', 8: 'Gornja Piskavica', 9: 'Kuljani', 10: 'Zalužani',
  11: 'Borkovići', 12: 'Bistrica', 13: 'Priječani', 14: 'Saračica', 15: 'Šargovac',
  16: 'Motike', 18: 'Stratinska', 22: 'Bronzani Majdan', 24: 'Čokori', 25: 'Česma',
  28: 'Goleši', 31: 'Vrbanja', 33: 'Donja Kola', 37: 'Srpske Toplice',
  38: 'Debeljaci', 39: 'Kmećani',
  41: 'Kola', 42: 'Rekavice 1', 43: 'Pavići', 44: 'Karanovac', 45: 'Rekavice 2',
  46: 'Ljubačevo', 47: 'Krmine', 48: 'Krupa na Vrbasu', 49: 'Stričići',
  50: 'Agino Selo', 51: 'Bočac',
};

// ── geometry helpers ──────────────────────────────────────────────────────────
const round6 = v => Math.round(v * 1e6) / 1e6;

function ringArea(ring) { // shoelace, deg² (CCW > 0); ring must be closed
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

function ringBbox(ring) {
  let w = 180, e = -180, s = 90, n = -90;
  for (const [lo, la] of ring) {
    if (lo < w) w = lo;
    if (lo > e) e = lo;
    if (la < s) s = la;
    if (la > n) n = la;
  }
  return { w, e, s, n };
}

const bboxIntersect = (a, b) =>
  a.w < b.e && b.w < a.e && a.s < b.n && b.s < a.n;

function pointInRing(lon, lat, ring) { // ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringCentroid(ring) { // area centroid, bbox-center fallback
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = ringBbox(ring);
    return [(b.w + b.e) / 2, (b.s + b.n) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

const areaM2 = ring => Math.abs(ringArea(ring)) *
  Math.cos(((ringBbox(ring).s + ringBbox(ring).n) / 2) * Math.PI / 180) *
  111320 * 111320;

// ── 1. absorb traced regions covered by hand-drawn polygons ──────────────────
const drawn = core.features.map(f => ({
  name: f.properties.name,
  ring: f.geometry.coordinates[0],
  bbox: ringBbox(f.geometry.coordinates[0]),
}));

console.log('── absorption check (traced → hand-drawn) ──');
const absorbed = [];
const partials = [];
const keptTraced = [];
for (const f of traced.features) {
  const id = f.properties.mz_id;
  const ring = f.geometry.coordinates[0];
  const bbox = ringBbox(ring);
  let best = null;
  const cov = [];
  let total = 0;
  for (const d of drawn) {
    if (!bboxIntersect(bbox, d.bbox)) continue;
    const pts = ring.slice(0, -1);
    let inside = 0;
    for (const [lo, la] of pts) if (pointInRing(lo, la, d.ring)) inside++;
    const frac = inside / pts.length;
    total += frac;
    if (frac > 0.001) cov.push(`${d.name}:${(frac * 100).toFixed(0)}%`);
    if (!best || frac > best.frac) best = { name: d.name, frac };
  }
  const collective = Math.min(1, total);
  if (best) {
    console.log(`  #${String(id).padStart(2)} bbox[${bbox.w.toFixed(3)},${bbox.s.toFixed(3)}..${bbox.e.toFixed(3)},${bbox.n.toFixed(3)}] n=${ring.length - 1} best=${best.name.padEnd(16)} ${(best.frac * 100).toFixed(0)}% collective ${(collective * 100).toFixed(0)}% (${cov.join(' + ')})`);
  }
  if (best && (best.frac >= 0.6 || collective >= 0.9)) {
    absorbed.push({ id, best });
  } else {
    if (best && best.frac >= 0.15) partials.push({ id, best });
    if (!NAMES[id]) throw new Error(`no name for kept traced region #${id}`);
    keptTraced.push(f);
  }
}
if (partials.length) {
  console.log('  partial overlaps (kept, review for gaps/double-cover):');
  for (const p of partials) {
    console.log(`    #${p.id} ↔ ${p.best.name}: ${(p.best.frac * 100).toFixed(0)}%`);
  }
}
console.log(`absorbed: ${absorbed.length}, kept traced: ${keptTraced.length}, ` +
  `hand-drawn: ${drawn.length}`);

// ── 2. build final feature list ──────────────────────────────────────────────
const features = [];
for (const d of drawn) {
  features.push({ name: d.name, ring: d.ring, source: 'manual-digitized', mzId: null });
}
for (const f of keptTraced) {
  features.push({ name: NAMES[f.properties.mz_id], ring: f.geometry.coordinates[0],
    source: 'trace', mzId: f.properties.mz_id });
}

for (const f of features) { // close, CCW, round
  const ring = f.ring.map(([lo, la]) => [round6(lo), round6(la)]);
  if (ring[0][0] !== ring[ring.length - 1][0] ||
      ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]]);
  if (ringArea(ring) < 0) ring.reverse();
  f.ring = ring;
}

const seen = new Map();
for (const f of features) seen.set(f.name, (seen.get(f.name) || 0) + 1);
for (const [n, c] of seen) if (c > 1) throw new Error(`duplicate name: ${n} (×${c})`);

// ── 3. validation report ─────────────────────────────────────────────────────
console.log('\n── polygons (priority = area rank, smaller first) ──');
const ranked = [...features].sort((a, b) => areaM2(a.ring) - areaM2(b.ring));
ranked.forEach((f, i) => { f.priority = i + 1; });
for (const f of ranked) {
  const c = ringCentroid(f.ring);
  console.log(`  ${String(f.priority).padStart(2)}  ${f.name.padEnd(20)} ` +
    `${Math.round(areaM2(f.ring)).toLocaleString('en').padStart(12)} m²  ` +
    `center ${c[1].toFixed(4)}, ${c[0].toFixed(4)}  ${f.source}`);
}

console.log('\n── spot checks (pin → containing MZ) ──');
const spots = [
  ['Trg Krajine (TEST PIN)', 44.7725, 17.1905],
  ['Ferhadija mosque', 44.7775, 17.1875],
  ['Borik center', 44.7830, 17.2080],
  ['University campus', 44.7930, 17.1940],
  ['Starcevica center', 44.7500, 17.2050],
  ['Obilicevo center', 44.7450, 17.1850],
  ['Krupa na Vrbasu', 44.8620, 17.0900],
  ['Vrbanja strip S', 44.7570, 17.1700],
];
for (const [label, la, lo] of spots) {
  const hit = features.filter(f => pointInRing(lo, la, f.ring))
    .sort((a, b) => a.priority - b.priority)[0];
  console.log(`  ${label.padEnd(24)} (${la}, ${lo}) → ${hit ? hit.name : '(none)'}`);
}

console.log('\n── pairwise overlap sampling ──');
let overlapPairs = 0;
const N = 50;
for (let i = 0; i < features.length; i++) {
  for (let j = i + 1; j < features.length; j++) {
    const A = features[i], B = features[j];
    const a = ringBbox(A.ring), b = ringBbox(B.ring);
    if (!bboxIntersect(a, b)) continue;
    const iw = Math.min(a.e, b.e) - Math.max(a.w, b.w);
    const ih = Math.min(a.n, b.n) - Math.max(a.s, b.s);
    if (iw <= 0 || ih <= 0) continue;
    let both = 0;
    for (let x = 1; x < N; x++) {
      for (let y = 1; y < N; y++) {
        const lo = Math.max(a.w, b.w) + iw * x / N;
        const la = Math.max(a.s, b.s) + ih * y / N;
        if (pointInRing(lo, la, A.ring) && pointInRing(lo, la, B.ring)) both++;
      }
    }
    const pct = 100 * both / (N * N);
    if (pct > 0.4) {
      overlapPairs++;
      console.log(`  OVERLAP ${A.name} ↔ ${B.name}: ~${pct.toFixed(1)}% of shared bbox cells`);
    }
  }
}
if (!overlapPairs) console.log('  no significant overlaps detected');

// ── 4. write output ──────────────────────────────────────────────────────────
const out = {
  type: 'FeatureCollection',
  features: ranked.map(f => ({
    type: 'Feature',
    properties: { name: f.name, source: f.source,
      ...(f.mzId != null ? { mz_id: f.mzId } : {}),
      priority: f.priority, area_m2: Math.round(areaM2(f.ring)) },
    geometry: { type: 'Polygon', coordinates: [f.ring] },
  })),
};
const outPath = path.join(GEO, 'banja-luka-mz-final.geojson');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
console.log(`\nwrote ${outPath}: ${out.features.length} features ` +
  `(${drawn.length} manual + ${keptTraced.length} traced)`);

