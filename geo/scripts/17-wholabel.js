'use strict';
// wholabel.js — which regions have label groups near a scan pixel?
const fs = require('fs');
const path = require('path');
const G = f => path.join('C:/Users/Korisnik/repos/pik-market-watch/geo', f);
const [qx, qy] = process.argv.slice(2).map(Number);
const la = JSON.parse(fs.readFileSync(G('debug/label-assign.json'), 'utf8'));
for (const [id, groups] of Object.entries(la)) {
  for (const g of groups) {
    const cx = (g.bbox[0] + g.bbox[2]) / 2, cy = (g.bbox[1] + g.bbox[3]) / 2;
    const d = Math.hypot(cx - qx, cy - qy);
    if (d < 250) {
      console.log(`region ${id}: group center (${cx.toFixed(0)}, ${cy.toFixed(0)}) ` +
        `dist ${d.toFixed(0)} npix ${g.npix} bbox [${g.bbox}]`);
    }
  }
}
