'use strict';
/* 12-warp.js — resample the scan onto a strict north-up lon/lat grid using
 * the fitted affine (debug/transform.json), removing rotation/shear so the
 * image can be used as an exact Leaflet imageOverlay for manual digitizing.
 * Writes debug/overlay.jpg + debug/overlay-bounds.json. */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const G = f => path.join(__dirname, '..', f);

(async () => {
  const tr = JSON.parse(fs.readFileSync(G('debug/transform.json'), 'utf8'));
  const { T, KX, KY, lon0, lat0 } = tr;
  const det = T.a * T.e - T.b * T.d;
  const inv = (X, Y) => [
    (T.e * (X - T.c) - T.b * (Y - T.f)) / det,
    (-T.d * (X - T.c) + T.a * (Y - T.f)) / det,
  ];

  const im = await Jimp.read(G('pdf-pages/page-1.png'));
  const W = im.bitmap.width, H = im.bitmap.height, src = im.bitmap.data;

  // geographic extent of the page corners (+ small margin)
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => {
    const X = T.a * x + T.b * y + T.c, Y = T.d * x + T.e * y + T.f;
    return [lon0 + X / KX, lat0 + Y / KY];
  });
  const pad = 0.005;
  const west = Math.min(...corners.map(c => c[0])) - pad;
  const east = Math.max(...corners.map(c => c[0])) + pad;
  const south = Math.min(...corners.map(c => c[1])) - pad;
  const north = Math.max(...corners.map(c => c[1])) + pad;

  const outW = 2400;
  const lonPerPx = (east - west) / outW;
  const latPerPx = lonPerPx * KX / KY; // same ground size per pixel
  const outH = Math.round((north - south) / latPerPx);
  console.log(`overlay ${outW}x${outH}, lon ${west.toFixed(4)}..${east.toFixed(4)}, lat ${south.toFixed(4)}..${north.toFixed(4)}`);

  const out = new Jimp(outW, outH);
  const dst = out.bitmap.data;
  for (let y = 0; y < outH; y++) {
    const lat = north - (y + 0.5) * latPerPx;
    const Y = (lat - lat0) * KY;
    for (let x = 0; x < outW; x++) {
      const lon = west + (x + 0.5) * lonPerPx;
      const X = (lon - lon0) * KX;
      const [px, py] = inv(X, Y);
      const o = (y * outW + x) * 4;
      if (px < 0 || py < 0 || px >= W - 1 || py >= H - 1) { dst[o + 3] = 255; continue; }
      const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = src[i00 + ch] * (1 - fx) * (1 - fy) + src[i10 + ch] * fx * (1 - fy) +
          src[i01 + ch] * (1 - fx) * fy + src[i11 + ch] * fx * fy;
        dst[o + ch] = v;
      }
      dst[o + 3] = 255;
    }
  }
  await out.quality(82).writeAsync(G('debug/overlay.jpg'));
  fs.writeFileSync(G('debug/overlay-bounds.json'), JSON.stringify({
    west, south, east, north, width: outW, height: outH,
    source: 'page-1.png warped through debug/transform.json (ICP vs OSM relation 2528156)',
  }, null, 1));
  const sz = fs.statSync(G('debug/overlay.jpg')).size;
  console.log(`wrote debug/overlay.jpg (${(sz / 1e6).toFixed(2)} MB) + overlay-bounds.json`);
})().catch(e => { console.error(e); process.exit(1); });
