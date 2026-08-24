'use strict';
/* crop.js — crop full-res scan windows and save viewer-friendly JPEGs.
 * usage: node crop.js out.jpg x y w h [maxW=1400] */
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const G = f => path.join(__dirname, '..', f);
(async () => {
  const [out, x, y, w, h, maxW] = process.argv.slice(2);
  const im = await Jimp.read(G('pdf-pages/page-1.png'));
  const X = +x, Y = +y, W = Math.min(+w, im.bitmap.width - X), H = Math.min(+h, im.bitmap.height - Y);
  const c = im.clone().crop(X, Y, W, H);
  const mw = +(maxW || 1400);
  if (c.bitmap.width > mw) c.resize(mw, Jimp.AUTO);
  c.quality(80);
  await c.writeAsync(G(path.join('debug', out)));
  console.log(`wrote debug/${out} ${c.bitmap.width}x${c.bitmap.height} ${fs.statSync(G(path.join('debug', out))).size} bytes`);
})().catch(e => { console.error(e); process.exit(1); });
