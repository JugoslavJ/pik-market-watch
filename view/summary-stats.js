// OLX.ba Price per m² — View: summary statistics panel

class SummaryStats {
  render(results) {
    const sales = results.filter(r => !r.isRent && r.ppm2);

    // #7 — IQR-clip outliers before computing median and colour tiers
    const rawVals             = sales.map(r => r.ppm2);
    const { values: clipped, clipped: nClipped } = iqrClip(rawVals);
    const vals   = clipped.sort((a, b) => a - b);
    const n      = vals.length;
    const median = computeMedian(vals);

    const newCount  = results.filter(r => r.isNew).length;
    const dropCount = results.filter(r => r.priceDrop).length;

    // #5 — median days on market (from pre-fetched r.days)
    const daysVals = results.filter(r => r.days).map(r => r.days);
    const medianDays = computeMedian(daysVals);

    const byRoom = {};
    for (const r of results) {
      if (r.isRent || !r.ppm2) continue;
      const raw = parseInt(r.rooms, 10);
      const key = isNaN(raw) ? null : raw >= 4 ? '4+' : String(raw);
      if (!key) continue;
      (byRoom[key] = byRoom[key] || []).push(r.ppm2);
    }
    const roomOrder  = ['0', '1', '2', '3', '4+'];
    const roomLabels = { '0': 'garsonjera', '1': '1-sob', '2': '2-sob', '3': '3-sob', '4+': '4+' };
    const roomBreakdown = roomOrder
      .filter(k => byRoom[k]?.length > 0)
      .map(k => {
        const { values: rv } = iqrClip(byRoom[k]);
        const med = computeMedian(rv.length ? rv : byRoom[k]);
        return `<span class="olx-room-median"><span class="olx-room-median-key">${roomLabels[k]}</span>${formatNumber(med)}</span>`;
      }).join('');

    const clippedNote = nClipped > 0
      ? `<span class="olx-stat-lbl" style="color:#9ca3af;font-size:9px;" title="${nClipped} outlier(a) izvan IQR raspona isključeno iz medijana">(${nClipped} izl.)</span>`
      : '';

    const newDropHtml = (newCount > 0 || dropCount > 0) ? `
      <div class="olx-stat">
        <span class="olx-stat-val" style="color:#10b981;">${newCount}</span>
        <span class="olx-stat-lbl">novo</span>
      </div>
      <div class="olx-stat">
        <span class="olx-stat-val" style="color:#f59e0b;">${dropCount}</span>
        <span class="olx-stat-lbl">pad cijene</span>
      </div>` : '';

    const daysHtml = medianDays != null ? `
      <div class="olx-stat" title="Medijan dana na tržištu (od prvog oglašavanja)">
        <span class="olx-stat-val">${medianDays}</span>
        <span class="olx-stat-lbl">med dana</span>
      </div>` : '';

    getElement('olx-results-summary').innerHTML = `
      <div class="olx-stat">
        <span class="olx-stat-val">${formatNumber(results.length)}</span>
        <span class="olx-stat-lbl">oglasa</span>
      </div>
      <div class="olx-stat" title="Medijan KM/m² (outlieri isključeni IQR metodom)">
        <span class="olx-stat-val">${formatNumber(median)}</span>
        <span class="olx-stat-lbl">med KM/m²</span>
        ${clippedNote}
      </div>
      <div class="olx-stat">
        <span class="olx-stat-val">${n > 0 ? formatNumber(vals[0]) : '—'}</span>
        <span class="olx-stat-lbl">min</span>
      </div>
      <div class="olx-stat">
        <span class="olx-stat-val">${n > 0 ? formatNumber(vals[n - 1]) : '—'}</span>
        <span class="olx-stat-lbl">max</span>
      </div>
      ${newDropHtml}
      ${daysHtml}
      ${roomBreakdown ? `<div class="olx-stat" style="gap:10px;border-right:none">${roomBreakdown}</div>` : ''}`;
    return median;
  }

  hide() { getElement('olx-results-summary').innerHTML = ''; }
}
