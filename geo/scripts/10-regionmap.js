'use strict';
/* 10-regionmap.js — render a scan window with each MZ yellow component in a
 * distinct pale color, red boundary/label pixels in black, and region ids
 * drawn at centroids. Makes label->region assignment visually unambiguous.
 * usage: node 10-regionmap.js out.png x y w h [downscale=1] */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { buildSegments } = require('./segment');
const { drawText } = require('./draw');
const G = f => path.join(__dirname, '..', f);

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => {
    t = ((t + 1) % 1);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
}

(async () => {
  const [out, x, y, w, h, dsArg] = process.argv.slice(2);
  const X = +x, Y = +y, WW = +w, WH = +h, ds = +(dsArg || 1);
  const { W, H, red, labels, regions } = buildSegments();
  console.log(`regions: ${regions.length} ids: ${regions.map(r => r.id).join(',')}`);

  // palette per region id (golden-ratio hue walk), legend swatch excluded
  const palette = new Map();
  let hi = 0;
  for (const r of regions) {
    if (r.cy > 6600) continue;
    palette.set(r.id, hsl(hi * 137.508 + 15, 0.55, 0.86));
    hi++;
  }

  const dw = Math.ceil(WW / ds), dh = Math.ceil(WH / ds);
  const im = new Jimp(dw, dh);
  const d = im.bitmap.data;
  const black = [25, 25, 25];
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx = Math.min(X + (x * ds) | 0, W - 1), sy = Math.min(Y + (y * ds) | 0, H - 1);
    const i = sy * W + sx, o = (y * dw + x) * 4;
    let c;
    if (red[i]) c = black;
    else {
      const lid = labels[i];
      c = lid && palette.has(lid) ? palette.get(lid) : [255, 255, 255];
    }
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
  }
  // region ids at centroids (white patch + black digits)
  for (const r of regions) {
    if (r.cy > 6600) continue;
    const cx = (r.cx - X) / ds, cy = (r.cy - Y) / ds;
    if (cx < 0 || cy < 0 || cx > dw - 30 || cy > dh - 16) continue;
    for (let yy = 0; yy < 15; yy++) for (let xx = 0; xx < 34; xx++) {
      const px = (cx | 0) + xx, py = (cy | 0) + yy;
      if (px < 0 || py < 0 || px >= dw || py >= dh) continue;
      const o = (py * dw + px) * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
    }
    drawText(d, dw, dh, `#${r.id}`, (cx | 0) + 2, (cy | 0) + 2, 2, black);
  }
  await im.writeAsync(G(path.join('debug', out)));
  console.log(`wrote debug/${out} ${dw}x${dh} ${fs.statSync(G(path.join('debug', out))).size} bytes`);
})().catch(e => { console.error(e); process.exit(1); });
