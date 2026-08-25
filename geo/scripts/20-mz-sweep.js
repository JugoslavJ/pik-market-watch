'use strict';
// 20-mz-sweep.js — rasterize the MZ polygons on a fine grid and report how
// well the set tiles the city:
//   overlaps — cells claimed by 2+ polygons (area + worst pairs)
//   seams    — empty cells whose window touches 2+ different MZs (border gaps)
//   holes    — other empty cells within SEAM_CELLS of covered land
// Optionally classifies pins (lines of "lat lon") by distance to the nearest
// polygon edge — separates fixable border stragglers from far-out rural pins.
//
// Usage: node 20-mz-sweep.js [geojson] [pins.txt]
// Env:   RES_M (cell size m, default 20), SEAM_CELLS (default 3)
const fs = require('fs');
const path = require('path');
const GEO = path.join(__dirname, '..');

const RES_M = Number(process.env.RES_M || 20);
const SEAM_CELLS = Number(process.env.SEAM_CELLS || 3);
const file = process.argv[2] || path.join(GEO, 'banja-luka-mz-final.geojson');
const pinsFile = process.argv[3];

const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
const polys = fc.features.map(f => ({
  name: f.properties.name,
  priority: f.properties.priority | 0,
  ring: f.geometry.coordinates[0],
})).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

// ── grid ─────────────────────────────────────────────────────────────────────
let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
for (const p of polys) {
  for (const [lo, la] of p.ring) {
    if (lo < lo0) lo0 = lo;
    if (lo > lo1) lo1 = lo;
    if (la < la0) la0 = la;
    if (la > la1) la1 = la;
  }
}
const midLat = (la0 + la1) / 2;
const dLat = RES_M / 111320;
const dLon = RES_M / (111320 * Math.cos(midLat * Math.PI / 180));
const cols = Math.ceil((lo1 - lo0) / dLon) + 1;
const rows = Math.ceil((la1 - la0) / dLat) + 1;
const N = rows * cols;
const cellLat = r => la0 + (r + 0.5) * dLat;
const cellLon = c => lo0 + (c + 0.5) * dLon;
console.log(`grid ${cols}x${rows} @ ${RES_M} m  bbox ${lo0.toFixed(4)},${la0.toFixed(4)} .. ${lo1.toFixed(4)},${la1.toFixed(4)}`);

// ── scanline fill: cover count + first-painter label (lowest priority wins) ──
const cover = new Uint8Array(N);
const label = new Int16Array(N).fill(-1);
for (let pi = 0; pi < polys.length; pi++) {
  const ring = polys[pi].ring;
  for (let r = 0; r < rows; r++) {
    const lat = cellLat(r);
    const xs = [];
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      if ((y1 > lat) !== (y2 > lat)) {
        xs.push(x1 + (lat - y1) * (x2 - x1) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.ceil((xs[k] - lo0) / dLon - 0.5);
      let c1 = Math.floor((xs[k + 1] - lo0) / dLon - 0.5);
      if (c0 < 0) c0 = 0;
      if (c1 > cols - 1) c1 = cols - 1;
      for (let c = c0; c <= c1; c++) {
        const idx = r * cols + c;
        cover[idx]++;
        if (label[idx] === -1) label[idx] = pi;
      }
    }
  }
}

// ── overlap stats ────────────────────────────────────────────────────────────
function pip(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pairCells = new Map();
let overlapCells = 0;
for (let idx = 0; idx < N; idx++) {
  if (cover[idx] < 2) continue;
  overlapCells++;
  const r = (idx / cols) | 0, c = idx % cols;
  const lat = cellLat(r), lon = cellLon(c);
  const hits = [];
  for (const p of polys) if (pip(lat, lon, p.ring)) hits.push(p);
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const key = hits[i].priority <= hits[j].priority
        ? `${hits[i].name} × ${hits[j].name}`
        : `${hits[j].name} × ${hits[i].name}`;
      pairCells.set(key, (pairCells.get(key) || 0) + 1);
    }
  }
}

// ── seam / hole detection: BFS distance from covered land ────────────────────
const INF = 255;
const dist = new Uint8Array(N).fill(INF);
const queue = new Int32Array(N);
let qh = 0, qt = 0;
for (let i = 0; i < N; i++) if (label[i] !== -1) { dist[i] = 0; queue[qt++] = i; }
while (qh < qt) {
  const i = queue[qh++];
  if (dist[i] >= SEAM_CELLS) continue;
  const r = (i / cols) | 0, c = i % cols;
  const nbs = [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1];
  for (const j of nbs) {
    if (j === -1 || dist[j] !== INF) continue;
    dist[j] = dist[i] + 1;
    queue[qt++] = j;
  }
}
let seamCells = 0, holeCells = 0, coveredCells = 0;
for (let i = 0; i < N; i++) {
  if (label[i] !== -1) { coveredCells++; continue; }
  if (dist[i] > SEAM_CELLS) continue;
  const r = (i / cols) | 0, c = i % cols;
  const names = new Set();
  for (let dr = -SEAM_CELLS; dr <= SEAM_CELLS; dr++) {
    for (let dc = -SEAM_CELLS; dc <= SEAM_CELLS; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const l = label[rr * cols + cc];
      if (l !== -1) names.add(l);
    }
  }
  if (names.size >= 2) seamCells++; else holeCells++;
}
const cellHa = RES_M * RES_M / 10000;
console.log(`covered: ${coveredCells} cells (${(coveredCells * cellHa).toFixed(0)} ha)`);
console.log(`overlaps: ${overlapCells} cells (${(overlapCells * cellHa).toFixed(1)} ha) claimed by 2+ MZs`);
for (const [k, v] of [...pairCells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`   ${String(v).padStart(5)} cells  ${k}`);
}
console.log(`empty-but-surrounded: ${seamCells + holeCells} cells (${((seamCells + holeCells) * cellHa).toFixed(1)} ha) within ${SEAM_CELLS * RES_M} m of land`);
console.log(`   seams (window touches 2+ MZs): ${seamCells}   other holes: ${holeCells}`);

// ── optional pin classification ──────────────────────────────────────────────
function segDistM(lat, lon, ring) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
  const px = lon * kx, py = lat * ky;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] * kx, ay = ring[j][1] * ky;
    const bx = ring[i][0] * kx, by = ring[i][1] * ky;
    const dx = bx - ax, dy = by - ay;
    const t = (dx === 0 && dy === 0) ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
if (pinsFile && fs.existsSync(pinsFile)) {
  const pins = fs.readFileSync(pinsFile, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => l.trim().split(/\s+/).map(Number))
    .map(([lat, lon]) => ({ lat, lon }));
  const buckets = [50, 100, 150, 200, 300, 500, 1000, Infinity];
  const hist = new Map();
  let insideCount = 0;
  const near = [];
  for (const pin of pins) {
    let host = null;
    for (const p of polys) if (pip(pin.lat, pin.lon, p.ring)) { host = p; break; }
    if (host) { insideCount++; continue; }
    let bestD = Infinity, bestName = '(none)';
    for (const p of polys) {
      const d = segDistM(pin.lat, pin.lon, p.ring);
      if (d < bestD) { bestD = d; bestName = p.name; }
    }
    const b = buckets.find(b => bestD <= b);
    hist.set(b === Infinity ? '>1000' : '<=' + b, (hist.get(b === Infinity ? '>1000' : '<=' + b) || 0) + 1);
    near.push({ d: Math.round(bestD), name: bestName, lat: pin.lat, lon: pin.lon });
  }
  console.log(`pins: ${pins.length} total, ${insideCount} already inside a polygon (?!), ${near.length} outside all`);
  for (const [k, v] of [...hist.entries()].sort((a, b) => parseFloat(a[0].replace(/[<=]/g, '')) - parseFloat(b[0].replace(/[<=]/g, '')))) {
    console.log(`   nearest edge ${k} m: ${v}`);
  }
  near.sort((a, b) => a.d - b.d);
  console.log('   15 closest:');
  for (const n of near.slice(0, 15)) console.log(`     ${String(n.d).padStart(5)} m -> ${n.name}  (${n.lat.toFixed(5)},${n.lon.toFixed(5)})`);
}

