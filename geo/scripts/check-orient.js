'use strict';
/* check-orient.js — sanity: map key world points through the inverse affine,
 * report where they land on the scan; also report scan->world for key pixels. */
const fs = require('fs');
const path = require('path');
const G = f => path.join(__dirname, '..', f);
const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
const { T, KX, KY, lon0, lat0 } = tr;
const det = T.a * T.e - T.b * T.d;
const toPx = (lon, lat) => {
  const X = (lon - lon0) * KX, Y = (lat - lat0) * KY;
  return [(T.e * (X - T.c) - T.b * (Y - T.f)) / det, (-T.d * (X - T.c) + T.a * (Y - T.f)) / det];
};
const toWorld = (x, y) => {
  const X = T.a * x + T.b * y + T.c, Y = T.d * x + T.e * y + T.f;
  return [lon0 + X / KX, lat0 + Y / KY];
};
console.log('--- world -> scan (inverse affine) ---');
const pts = {
  north_tip: [16.9, 44.9878],
  south_tip: [16.9, 44.49],
  west_tip: [16.7925, 44.7],
  east_tip: [17.303, 44.7],
  trg_krajine: [17.1905, 44.7725],
};
for (const [k, [lo, la]] of Object.entries(pts)) {
  const [x, y] = toPx(lo, la);
  console.log(k.padEnd(12), lo, la, '-> scan px', x.toFixed(0), y.toFixed(0));
}
console.log('--- scan -> world (forward affine) ---');
const px = { urban_core_guess: [3700, 2500], scan_top: [2483, 100], scan_bottom: [2483, 6900], scan_left: [300, 3500], scan_right: [4600, 3500], legend: [451, 6828] };
for (const [k, [x, y]] of Object.entries(px)) {
  const [lo, la] = toWorld(x, y);
  console.log(k.padEnd(12), `(${x},${y})`, '->', lo.toFixed(4), la.toFixed(4));
}
