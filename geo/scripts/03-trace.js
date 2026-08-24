'use strict';
/* 03-trace.js — trace each region's outer boundary (crack following on the
 * pixel grid, interior on right), simplify with Douglas-Peucker, and write
 * debug/regions-pixel.json (rings in full-res scan pixel coords). */
const fs = require('fs');
const path = require('path');
const { loadScan, classify, dilate, connectedComponents } = require('./common');

const EPS = 2.0; // DP simplification, px

const { W, H, data } = loadScan();
const { red, yellow } = classify(data, W, H);
const redDil = dilate(red, W, H, 2);
const area = new Uint8Array(W * H);
for (let i = 0; i < area.length; i++) area[i] = yellow[i] && !redDil[i] ? 1 : 0;
const { labels, regions } = connectedComponents(area, W, H, 4000);

const W1 = W + 1;
// directed boundary edges per region: id -> Map(fromVertexKey -> [toKey, dir, ...])
const edges = new Map();
const nb = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 0 : labels[y * W + x];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const L = labels[y * W + x];
    if (!L) continue;
    let m = edges.get(L);
    if (!m) { m = new Map(); edges.set(L, m); }
    const add = (fx, fy, tx, ty, dir) => {
      const k = fy * W1 + fx;
      let arr = m.get(k);
      if (!arr) { arr = []; m.set(k, arr); }
      arr.push(ty * W1 + tx, dir);
    };
    if (nb(x, y - 1) !== L) add(x, y, x + 1, y, 0);         // top    -> E
    if (nb(x + 1, y) !== L) add(x + 1, y, x + 1, y + 1, 1); // right  -> S
    if (nb(x, y + 1) !== L) add(x + 1, y + 1, x, y + 1, 2); // bottom -> W
    if (nb(x - 1, y) !== L) add(x, y + 1, x, y, 3);         // left   -> N
  }
}

function trace(m) {
  let startK = Infinity;
  for (const k of m.keys()) if (k < startK) startK = k;
  const pts = [];
  let cur = startK, dir = -1, guard = 0;
  const maxSteps = m.size * 4 + 16;
  do {
    const arr = m.get(cur);
    if (!arr) throw new Error('walk hit vertex without outgoing edge');
    const prefs = dir === -1 ? [0, 1, 2, 3] : [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
    let next = -1, ndir = -1;
    for (const want of prefs) {
      for (let i = 1; i < arr.length; i += 2) {
        if (arr[i] === want) { next = arr[i - 1]; ndir = want; break; }
      }
      if (next >= 0) break;
    }
    if (next < 0) throw new Error('dead end in walk');
    pts.push([cur % W1, (cur / W1) | 0]);
    dir = ndir; cur = next;
    if (++guard > maxSteps) throw new Error('walk did not close');
  } while (cur !== startK);
  return pts;
}

function simplify(pts, eps) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    if (b <= a + 1) continue;
    const x1 = pts[a][0], y1 = pts[a][1], dx = pts[b][0] - x1, dy = pts[b][1] - y1;
    const len2 = dx * dx + dy * dy;
    let dmax = -1, imax = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      let d;
      if (len2 === 0) { const ex = px - x1, ey = py - y1; d = ex * ex + ey * ey; }
      else {
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
        d = ex * ex + ey * ey;
      }
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > eps * eps) { keep[imax] = 1; st.push([a, imax], [imax, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const out = [];
console.log(' id  raw -> simp vertices');
for (const r of regions) {
  const m = edges.get(r.id);
  if (!m) { console.log(`region ${r.id}: no edges?!`); continue; }
  const raw = trace(m);
  const simp = simplify(raw, EPS);
  out.push({ id: r.id, npix: r.npix, cx: r.cx, cy: r.cy, bbox: [r.minX, r.minY, r.maxX, r.maxY], ring: simp });
  console.log(String(r.id).padStart(3), String(raw.length).padStart(6), '->', String(simp.length).padStart(4));
}
fs.writeFileSync(
  path.join(__dirname, '..', 'debug', 'regions-pixel.json'),
  JSON.stringify({ W, H, eps: EPS, regions: out })
);
console.log('wrote debug/regions-pixel.json');
