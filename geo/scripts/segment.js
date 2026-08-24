'use strict';
/* segment.js — improved MZ segmentation shared by downstream scripts.
 *
 * Fixes vs the original inline method (yellow && !redDil(2), CC 4000):
 * 1. Label-split repair: a big red MZ name printed across a region seals the
 *    yellow fill and splits one MZ into two components (e.g. Росуље = 21+26).
 *    Isolated, compact, yellow-surrounded red "label-like" components are
 *    bridged (union via CC of area+labelMask) so pieces become one region.
 * 2. Gap fill: urban fabric inside an MZ is uncolored; barrier-bounded BFS
 *    assigns those pixels to the surrounding region.
 * Legacy ids are kept stable via majority-overlap remapping; orphan pieces
 * get fresh ids >= 100. */
const { loadScan, classify, dilate, connectedComponents } = require('./common');

function buildSegments(opts = {}) {
  const { fillGaps = true, minSize = 4000 } = opts;
  const { W, H, data } = loadScan();
  const { red, yellow } = classify(data, W, H);
  const redDil1 = dilate(red, W, H, 1);
  const redDil2 = dilate(red, W, H, 2);

  // legacy segmentation (ids the transcription work is keyed on)
  const areaA = new Uint8Array(W * H);
  for (let i = 0; i < areaA.length; i++) areaA[i] = yellow[i] && !redDil2[i] ? 1 : 0;
  const legacy = connectedComponents(areaA, W, H, minSize);
  const legacyIdOf = legacy.labels; // pixel -> legacy id (0 none); reused below

  // label-like red components: not the boundary network, compact, on yellow
  const { labels: rl, regions: rregs } = connectedComponents(red, W, H, 1);
  let netId = 0, netN = 0;
  for (const c of rregs) if (c.npix > netN) { netN = c.npix; netId = c.id; }
  const labelMask = new Uint8Array(W * H);
  const isLabelAcc = [];
  for (const c of rregs) {
    if (c.id === netId || c.npix < 120 || c.npix > 25000) continue;
    if (c.cy > 6600) continue; // legend swatch area
    const bw = c.maxX - c.minX, bh = c.maxY - c.minY;
    if (bw < 18 || bh < 18) continue;         // lone digits/dots
    if (bw > 720 || bh > 90) continue;        // labels are compact
    if (bw > 8 * bh || bh > 8 * bw) continue; // elongated line fragments
    // yellow share of the ring AROUND the component (glyphs themselves are red)
    const R = 4;
    const x0 = Math.max(0, c.minX - R), y0 = Math.max(0, c.minY - R);
    const x1 = Math.min(W - 1, c.maxX + R), y1 = Math.min(H - 1, c.maxY + R);
    const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
    const lm = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      if (rl[(y0 + y) * W + (x0 + x)] === c.id) lm[y * lw + x] = 1;
    }
    const ld = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      if (!lm[y * lw + x]) continue;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < lw && yy < lh) ld[yy * lw + xx] = 1;
      }
    }
    let tot = 0, yel = 0, redN = 0;
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const i = (y0 + y) * W + (x0 + x);
      if (ld[y * lw + x] && rl[i] !== c.id) {
        tot++;
        if (yellow[i]) yel++;
        if (red[i]) redN++;
      }
    }
    // split-label ring is ~all yellow; a label at an MZ junction has boundary
    // lines (red) in its ring -> bridging those would merge distinct MZs
    if (tot < 100 || yel / Math.max(1, tot) < 0.5 || redN / Math.max(1, tot) > 0.12) continue;
    isLabelAcc.push(c);
    for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) {
      const i = y * W + x;
      if (rl[i] === c.id) labelMask[i] = 1;
    }
  }
  const labelDil2 = dilate(labelMask, W, H, 2); // covers redDil2 seal around glyphs

  // merged mask = legacy area + label bridges; CC -> union-find groups
  const mergedMask = new Uint8Array(W * H);
  for (let i = 0; i < mergedMask.length; i++) mergedMask[i] = areaA[i] || labelDil2[i] ? 1 : 0;
  const merged = connectedComponents(mergedMask, W, H, 1);

  // per merged comp: votes for legacy ids; majority wins, losers get fresh ids
  const votesOf = new Map(); // mergedId -> Map(legacyId -> npix)
  for (let i = 0; i < W * H; i++) {
    const m = merged.labels[i];
    if (!m) continue;
    const l = legacyIdOf[i];
    if (!l) continue;
    let v = votesOf.get(m);
    if (!v) votesOf.set(m, v = new Map());
    v.set(l, (v.get(l) || 0) + 1);
  }
  // claim: legacyId -> merged comp with most legacy pixels
  const claim = new Map();
  const majorityOf = new Map();
  for (const [m, v] of votesOf) {
    let bid = 0, bn = 0;
    for (const [l, n] of v) if (n > bn) { bn = n; bid = l; }
    majorityOf.set(m, bid);
    const prev = claim.get(bid);
    if (prev === undefined || v.get(bid) > votesOf.get(prev).get(bid)) claim.set(bid, m);
  }
  const finalIdOfMerged = new Int32Array(nextMergedId(merged.labels) + 1);
  let nextFresh = 100;
  for (const [m, bid] of majorityOf) {
    finalIdOfMerged[m] = claim.get(bid) === m ? bid : nextFresh++;
  }

  const labels = new Int32Array(W * H);
  for (let i = 0; i < labels.length; i++) {
    const m = merged.labels[i];
    if (m) labels[i] = finalIdOfMerged[m] || 0;
  }

  if (fillGaps) {
    // multi-source BFS into unlabeled non-barrier pixels; barrier = redDil1
    const queue = new Int32Array(W * H);
    let qt = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i]) queue[qt++] = i;
    for (let qh = 0; qh < qt; qh++) {
      const p = queue[qh], id = labels[p], x = p % W;
      const tryN = q => { if (!labels[q] && !redDil1[q]) { labels[q] = id; queue[qt++] = q; } };
      if (x > 0) tryN(p - 1);
      if (x < W - 1) tryN(p + 1);
      if (p >= W) tryN(p - W);
      if (p < W * (H - 1)) tryN(p + W);
    }
  }

  // region stats
  const acc = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = labels[y * W + x];
    if (!id) continue;
    let a = acc.get(id);
    if (!a) acc.set(id, a = { npix: 0, sx: 0, sy: 0, minX: W, maxX: 0, minY: H, maxY: 0 });
    a.npix++; a.sx += x; a.sy += y;
    if (x < a.minX) a.minX = x; if (x > a.maxX) a.maxX = x;
    if (y < a.minY) a.minY = y; if (y > a.maxY) a.maxY = y;
  }
  const regions = [...acc.entries()].map(([id, a]) => ({
    id, npix: a.npix, cx: a.sx / a.npix, cy: a.sy / a.npix,
    minX: a.minX, maxX: a.maxX, minY: a.minY, maxY: a.maxY,
  })).sort((p, q) => p.id - q.id);

  const debug = opts.debug ? {
    accepted: isLabelAcc.map(c => ({ bbox: [c.minX, c.minY, c.maxX, c.maxY], npix: c.npix })),
    multiMerges: [...votesOf.entries()]
      .filter(([, v]) => v.size > 1)
      .map(([m, v]) => ({ merged: m, votes: [...v.entries()].sort((a, b) => b[1] - a[1]) })),
  } : null;

  return { W, H, data, red, yellow, labels, regions, labelMask, debug };
}

module.exports = { buildSegments };

function nextMergedId(labels) {
  let mx = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > mx) mx = labels[i];
  return mx;
}

