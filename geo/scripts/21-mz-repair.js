'use strict';
// 21-mz-repair.js — rebuild the MZ set from a gap-filled, overlap-free
// rasterization of itself (companion to 20-mz-sweep.js):
//   1. scanline-rasterize all polygons on a RES_M grid; on overlaps the lowest
//      priority wins (same tie-break as neighborhood_of) -> overlaps gone
//   2. multi-source BFS claims empty cells within GAP_CELLS of covered land
//      -> border seams and interior holes closed
//   3. each MZ mask is contoured, Douglas-Peucker simplified, forced CCW
//      (RFC 7946) and rounded to 6 dp, then written back as the
//      FeatureCollection (original stays in git history; regenerate the SQL
//      with 19-gen-sql.js afterwards and re-run the backfill unguarded)
// Env: RES_M (default 20), GAP_CELLS (default 8 = 160 m), SIMPLIFY_M (default 12)
const fs = require('fs');
const path = require('path');
const GEO = path.join(__dirname, '..');

const RES_M = Number(process.env.RES_M || 20);
const GAP_CELLS = Number(process.env.GAP_CELLS || 8);
const SIMPLIFY_M = Number(process.env.SIMPLIFY_M || 12);
const file = path.join(GEO, 'banja-luka-mz-final.geojson');

const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
const feats = fc.features.map(f => ({
  name: f.properties.name,
  priority: f.properties.priority | 0,
  source: f.properties.source,
  mz_id: f.properties.mz_id,
  ring: f.geometry.coordinates[0],
}));
const order = feats.map((f, i) => i)
  .sort((a, b) => feats[a].priority - feats[b].priority || feats[a].name.localeCompare(feats[b].name));

// ── grid ─────────────────────────────────────────────────────────────────────
let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
for (const f of feats) {
  for (const [lo, la] of f.ring) {
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
console.log(`grid ${cols}x${rows} @ ${RES_M} m, GAP_CELLS=${GAP_CELLS}, SIMPLIFY_M=${SIMPLIFY_M}`);

// ── scanline rasterization: cover count + first-painter label ────────────────
function rasterize(ringsSorted) {
  const cover = new Uint8Array(N);
  const label = new Int16Array(N).fill(-1);
  for (let pi = 0; pi < ringsSorted.length; pi++) {
    const ring = ringsSorted[pi];
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
  return { cover, label };
}

// ── metrics (same definitions as 20-mz-sweep.js) ─────────────────────────────
function metrics(cover, label) {
  let covered = 0, overlap = 0, seam = 0, hole = 0;
  const INF = 255;
  const dist = new Uint8Array(N).fill(INF);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (label[i] !== -1) { dist[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++];
    if (dist[i] >= 3) continue;
    const r = (i / cols) | 0, c = i % cols;
    for (const j of [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1]) {
      if (j === -1 || dist[j] !== INF) continue;
      dist[j] = dist[i] + 1;
      q[qt++] = j;
    }
  }
  for (let i = 0; i < N; i++) {
    if (label[i] !== -1) { covered++; if (cover[i] > 1) overlap++; continue; }
    if (dist[i] > 3) continue;
    const r = (i / cols) | 0, c = i % cols;
    const names = new Set();
    for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -3; dc <= 3; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const l = label[rr * cols + cc];
        if (l !== -1) names.add(l);
      }
    }
    if (names.size >= 2) seam++; else hole++;
  }
  return { covered, overlap, seam, hole };
}

// ── BFS gap fill ─────────────────────────────────────────────────────────────
function bfsFill(label, gapCells) {
  const INF = 255;
  const dist = new Uint8Array(N).fill(INF);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (label[i] !== -1) { dist[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++];
    if (dist[i] >= gapCells) continue;
    const r = (i / cols) | 0, c = i % cols;
    for (const j of [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1]) {
      if (j === -1 || label[j] !== -1 || dist[j] !== INF) continue;
      dist[j] = dist[i] + 1;
      label[j] = label[i];
      q[qt++] = j;
    }
  }
}

// ── contour tracing: longest loop of a label's cell mask ─────────────────────
const keyR = (k, w) => (k / w) | 0;
const keyC = (k, w) => k % w;
function traceLongestLoop(label, target) {
  const w = cols + 1;
  const edges = [];
  const key = (r, c) => r * w + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (label[r * cols + c] !== target) continue;
      const above = r > 0 && label[(r - 1) * cols + c] === target;
      const below = r < rows - 1 && label[(r + 1) * cols + c] === target;
      const left = c > 0 && label[r * cols + c - 1] === target;
      const right = c < cols - 1 && label[r * cols + c + 1] === target;
      if (!above) edges.push([key(r, c), key(r, c + 1)]);
      if (!below) edges.push([key(r + 1, c), key(r + 1, c + 1)]);
      if (!left) edges.push([key(r, c), key(r + 1, c)]);
      if (!right) edges.push([key(r, c + 1), key(r + 1, c + 1)]);
    }
  }
  const adj = new Map();
  edges.forEach((e, i) => {
    for (const k of e) {
      let a = adj.get(k);
      if (!a) { a = []; adj.set(k, a); }
      a.push(i);
    }
  });
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [edges[i][0], edges[i][1]];
    let prev = edges[i][0], cur = edges[i][1];
    let guard = edges.length + 1;
    while (cur !== loop[0] && guard-- > 0) {
      const cands = (adj.get(cur) || []).filter(e => !used[e]);
      if (cands.length === 0) break;
      let pick = cands[0];
      if (cands.length > 1) {
        const drIn = Math.sign(keyR(cur, w) - keyR(prev, w));
        const dcIn = Math.sign(keyC(cur, w) - keyC(prev, w));
        let bestScore = -1;
        for (const cd of cands) {
          const other = edges[cd][0] === cur ? edges[cd][1] : edges[cd][0];
          const drOut = Math.sign(keyR(other, w) - keyR(cur, w));
          const dcOut = Math.sign(keyC(other, w) - keyC(cur, w));
          let score = 0;
          if (drOut === dcIn && dcOut === -drIn) score = 3;       // left turn
          else if (drOut === drIn && dcOut === dcIn) score = 2;   // straight
          else if (drOut === -dcIn && dcOut === drIn) score = 1;  // right turn
          if (score > bestScore) { bestScore = score; pick = cd; }
        }
      }
      used[pick] = 1;
      const other = edges[pick][0] === cur ? edges[pick][1] : edges[pick][0];
      prev = cur;
      cur = other;
      loop.push(cur);
    }
    loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  if (loops.length > 1) {
    console.log(`   note: target ${target} produced ${loops.length} loops; keeping the longest (${loops[0].length} corners), dropping ${loops.slice(1).reduce((s, l) => s + l.length, 0)} corners`);
  }
  return loops[0] || null;
}

// ── Douglas-Peucker in local meters ──────────────────────────────────────────
function simplifyRing(ring, tolM) {
  const kx = 111320 * Math.cos(midLat * Math.PI / 180), ky = 111320;
  const pts = ring.map(([lo, la]) => [lo * kx, la * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (len2 === 0) {
        const ex = pts[i][0] - ax, ey = pts[i][1] - ay;
        d = ex * ex + ey * ey;
      } else {
        let t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const ex = pts[i][0] - (ax + t * dx), ey = pts[i][1] - (ay + t * dy);
        d = ex * ex + ey * ey;
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxI !== -1 && maxD > tolM * tolM) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const beforeRings = order.map(i => feats[i].ring);
const g1 = rasterize(beforeRings);
const before = metrics(g1.cover, g1.label);

bfsFill(g1.label, GAP_CELLS);

const newRings = new Array(feats.length);
let droppedLoops = 0;
for (let s = 0; s < order.length; s++) {
  const fi = order[s];
  const loop = traceLongestLoop(g1.label, s);
  if (!loop || loop.length < 4) throw new Error(`could not trace ${feats[fi].name}`);
  let ring = loop.map(k => {
    const r = keyR(k, cols + 1), c = keyC(k, cols + 1);
    return [lo0 + c * dLon, la0 + r * dLat];
  });
  ring = simplifyRing(ring, SIMPLIFY_M);
  const dedup = [];
  for (const pt of ring) {
    const last = dedup[dedup.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) dedup.push(pt);
  }
  if (dedup.length > 2 && dedup[0][0] === dedup[dedup.length - 1][0] && dedup[0][1] === dedup[dedup.length - 1][1]) {
    dedup.pop();
  }
  if (dedup.length < 3) throw new Error(`degenerate ring for ${feats[fi].name}`);
  let area = 0;
  for (let i = 0, j = dedup.length - 1; i < dedup.length; j = i++) {
    area += (dedup[j][0] - dedup[i][0]) * (dedup[j][1] + dedup[i][1]);
  }
  if (area < 0) dedup.reverse();
  const clean = dedup.map(([lo, la]) => [Number(lo.toFixed(6)), Number(la.toFixed(6))]);
  clean.push(clean[0]);
  newRings[fi] = clean;
  console.log(`${String(feats[fi].priority).padStart(3)}  ${feats[fi].name.padEnd(20)} ${String(feats[fi].ring.length - 1).padStart(5)} -> ${String(clean.length - 1).padStart(5)} verts`);
}

const g2 = rasterize(newRings.slice());
const after = metrics(g2.cover, g2.label);
const ha = RES_M * RES_M / 10000;
console.log('');
console.log('metric                 before        after');
console.log(`covered cells    ${String(before.covered).padStart(10)}  ${String(after.covered).padStart(10)}`);
console.log(`overlap cells    ${String(before.overlap).padStart(10)}  ${String(after.overlap).padStart(10)}`);
console.log(`seam cells       ${String(before.seam).padStart(10)}  ${String(after.seam).padStart(10)}`);
console.log(`hole cells       ${String(before.hole).padStart(10)}  ${String(after.hole).padStart(10)}`);
console.log(`dropped extra loops: ${droppedLoops + (droppedLoops ? '' : ' none noted above')}`);

const outFc = {
  type: 'FeatureCollection',
  features: fc.features.map((f, i) => ({
    type: 'Feature',
    properties: { ...f.properties },
    geometry: { type: 'Polygon', coordinates: [newRings[i]] },
  })),
};
fs.writeFileSync(file, JSON.stringify(outFc));
console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${outFc.features.length} features)`);


