'use strict';
/* geo-icp.js — point-to-point ICP with affine model + spatial-hash NN. */
function buildHash(B, cell) {
  const h = new Map();
  for (let i = 0; i < B.length; i++) {
    const k = (Math.floor(B[i][1] / cell) << 12) | Math.floor(B[i][0] / cell);
    let a = h.get(k); if (!a) { a = []; h.set(k, a); }
    a.push(i);
  }
  return { h, cell, pts: B };
}
function nearest(hash, p) {
  const fx = Math.floor(p[0] / hash.cell), fy = Math.floor(p[1] / hash.cell);
  let bi = -1, bd = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const a = hash.h.get(((fy + dy) << 12) | (fx + dx));
    if (!a) continue;
    for (const i of a) {
      const q = hash.pts[i];
      const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]);
      if (d < bd) { bd = d; bi = i; }
    }
  }
  return bi < 0 ? null : { idx: bi, d: Math.sqrt(bd) };
}
function solve3(M, v) {
  const m = [M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8]].map((x, i) => x * 1);
  const b = [v[0], v[1], v[2]];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r * 3 + c]) > Math.abs(m[piv * 3 + c])) piv = r;
    if (piv !== c) { for (let k = 0; k < 3; k++) { let t = m[c * 3 + k]; m[c * 3 + k] = m[piv * 3 + k]; m[piv * 3 + k] = t; } const t = b[c]; b[c] = b[piv]; b[piv] = t; }
    for (let r = c + 1; r < 3; r++) {
      const f = m[r * 3 + c] / m[c * 3 + c];
      for (let k = c; k < 3; k++) m[r * 3 + k] -= f * m[c * 3 + k];
      b[r] -= f * b[c];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 3; k++) s -= m[r * 3 + k] * x[k];
    x[r] = s / m[r * 3 + r];
  }
  return x;
}
function applyT(T, p) { return [T.a * p[0] + T.b * p[1] + T.c, T.d * p[0] + T.e * p[1] + T.f]; }

/* bbox-align A onto B, optionally rotating A about its centroid by rot (rad);
 * flipY/flipX mirror the respective axes while keeping bbox alignment — needed
 * because a north-up scan must map scan-top -> north, and a plain bbox align
 * always maps top -> bottom (south), which traps ICP in a flipped local minimum. */
function evalInit(A, B, rot, opts = {}) {
  const bb = (P) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; };
  let cx = 0, cy = 0;
  for (const p of A) { cx += p[0]; cy += p[1]; }
  cx /= A.length; cy /= A.length;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const Ar = A.map(p => [cx + (p[0] - cx) * cos - (p[1] - cy) * sin, cy + (p[0] - cx) * sin + (p[1] - cy) * cos]);
  const [ax0, ay0, ax1, ay1] = bb(Ar), [bx0, by0, bx1, by1] = bb(B);
  const sx = (bx1 - bx0) / (ax1 - ax0), sy = (by1 - by0) / (ay1 - ay0);
  const tx = opts.flipX ? -sx : sx, ox = opts.flipX ? bx1 : bx0;
  const ty = opts.flipY ? -sy : sy, oy = opts.flipY ? by1 : by0;
  const T = { a: tx, b: 0, c: ox - tx * ax0, d: 0, e: ty, f: oy - ty * ay0 };
  const hash = buildHash(B, 150);
  let sum = 0, n = 0;
  for (let i = 0; i < Ar.length; i += Math.max(1, Math.floor(Ar.length / 1500))) {
    const nn = nearest(hash, applyT(T, Ar[i]));
    if (nn) { sum += nn.d; n++; }
  }
  return { T, meanRes: n ? sum / n : Infinity };
}

function fitAffineICP(A, B, initT, opts = {}) {
  const iters = opts.iters || 30, cell = opts.cell || 150;
  const hash = buildHash(B, cell);
  let T = { ...initT };
  let stats = { mean: Infinity, max: Infinity, inliers: 0 };
  for (let it = 0; it < iters; it++) {
    const P = [];
    for (const p of A) {
      const q = applyT(T, p);
      const nn = nearest(hash, q);
      if (nn) P.push([p[0], p[1], B[nn.idx][0], B[nn.idx][1], nn.d]);
    }
    if (P.length < 100) break;
    const ds = P.map(r => r[4]).sort((x, y) => x - y);
    const med = ds[ds.length >> 1];
    const q60 = ds[(ds.length * 0.6) | 0];
    const thresh = Math.max(2.5 * med, q60);
    const K = P.filter(r => r[4] <= thresh);
    // normal equations
    let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, SXx = 0, SYx = 0, SXy = 0, SYy = 0, SX = 0, SY = 0;
    for (const [x, y, X, Y] of K) {
      Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y;
      SXx += x * X; SXy += y * X; SX += X;
      SYx += x * Y; SYy += y * Y; SY += Y;
    }
    const n = K.length, M = [Sxx, Sxy, Sx, Sxy, Syy, Sy, Sx, Sy, n];
    const [a, b, c] = solve3(M, [SXx, SXy, SX]);
    const [d, e, f] = solve3(M, [SYx, SYy, SY]);
    const dT = Math.max(Math.abs(a - T.a), Math.abs(b - T.b), Math.abs(c - T.c), Math.abs(d - T.d), Math.abs(e - T.e), Math.abs(f - T.f));
    T = { a, b, c, d, e, f };
    let sum = 0, mx = 0;
    for (const r of K) { sum += r[4]; if (r[4] > mx) mx = r[4]; }
    stats = { mean: sum / K.length, max: mx, inliers: K.length };
    if (opts.log) console.log(`  iter ${it}: pairs=${P.length} inliers=${K.length} mean=${stats.mean.toFixed(1)} max=${mx.toFixed(1)}`);
    if (dT < 1e-7) break;
  }
  // honest full-stats: residual of EVERY A point against B with the final T
  const ds = [];
  for (const p of A) { const nn = nearest(hash, applyT(T, p)); if (nn) ds.push(nn.d); }
  ds.sort((x, y) => x - y);
  const pick = f => ds[Math.min(ds.length - 1, (ds.length * f) | 0)];
  stats.all = {
    n: ds.length,
    mean: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : Infinity,
    median: pick(0.5), p90: pick(0.9), max: ds[ds.length - 1] ?? Infinity,
  };
  return { T, stats };
}
module.exports = { fitAffineICP, evalInit, applyT };
