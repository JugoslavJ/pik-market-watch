'use strict';
/* tojpg.js — CLI: node tojpg.js a.png b.png ... -> writes .jpg (q70) next to each */
const Jimp = require('jimp');
(async () => {
  for (const f of process.argv.slice(2)) {
    const img = await Jimp.read(f);
    const out = f.replace(/\.png$/i, '.jpg');
    await img.quality(70).writeAsync(out);
    console.log('wrote', out);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
