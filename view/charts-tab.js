// OLX.ba Price per m² — View: Price per m² — charts tab

class ChartsTab {
  constructor(db, searchKey) {
    this._db        = db;
    this._searchKey = searchKey;
    this._results   = [];
    this._median    = null;
  }

  update(results, median) {
    this._results = results;
    this._median  = median;
    if (!getElement('olx-charts-pane')?.classList.contains('olx-tab-pane-active')) return;
    this._render();
  }

  activate() {
    const pane = getElement('olx-charts-pane');
    if (!pane) return;
    this._render(pane);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _render(pane) {
    pane = pane || getElement('olx-charts-pane');
    if (!pane) return;
    const validResults = this._results.filter(r => !r.isRent && r.ppm2 != null);
    if (!validResults.length) {
      pane.innerHTML = '<div class="olx-chart-empty">Nema podataka. Pokrenite skeniranje.</div>';
      return;
    }
    this._renderCharts(pane, validResults);
  }

  _renderCharts(pane, results) {
    pane.innerHTML = `
      <div class="olx-chart-section">
        <div class="olx-chart-title">Distribucija KM/m² — broj oglasa po cjenovnom razredu</div>
        <div class="olx-chart-subtitle" id="olx-chart-hist-subtitle"></div>
        <div class="olx-chart-wrap">
          <canvas id="olx-chart-hist" width="700" height="180" style="width:100%;height:180px;display:block;"></canvas>
        </div>
        <div class="olx-chart-legend">
          <span class="olx-chart-legend-item"><span class="olx-chart-legend-swatch" style="background:#6ee7b7"></span>≤ 80% medijana</span>
          <span class="olx-chart-legend-item"><span class="olx-chart-legend-swatch" style="background:#a7f3d0"></span>80–100%</span>
          <span class="olx-chart-legend-item"><span class="olx-chart-legend-swatch" style="background:#fde68a"></span>100–120%</span>
          <span class="olx-chart-legend-item"><span class="olx-chart-legend-swatch" style="background:#fca5a5"></span>&gt; 120%</span>
          <span class="olx-chart-legend-item" style="margin-left:8px;"><span style="display:inline-block;width:18px;height:2px;background:#002f34;border-top:2px dashed #002f34;vertical-align:middle;margin-right:4px;"></span>Medijan</span>
        </div>
      </div>
      <div class="olx-chart-section">
        <div class="olx-chart-title">Medijan KM/m² i IQR raspon po broju soba</div>
        <div class="olx-chart-wrap">
          <canvas id="olx-chart-rooms" width="700" height="160" style="width:100%;height:160px;display:block;"></canvas>
        </div>
        <div class="olx-chart-legend">
          <span class="olx-chart-legend-item"><span class="olx-chart-legend-swatch" style="background:#dbeafe;border:1px solid #93c5fd;"></span>IQR raspon (25–75%)</span>
          <span class="olx-chart-legend-item"><span style="display:inline-block;width:18px;height:0;border-top:2px solid #002f34;vertical-align:middle;margin-right:4px;"></span>Medijan</span>
          <span class="olx-chart-legend-item"><span style="display:inline-block;width:18px;height:0;border-top:2px dashed #f59e0b;vertical-align:middle;margin-right:4px;"></span>Ukupni medijan</span>
          <span class="olx-chart-legend-item" style="color:#9ca3af;">n= broj oglasa, (-x) = isključeni outlieri</span>
        </div>
      </div>`;

    requestAnimationFrame(() => {
      this._drawHistogram(pane.querySelector('#olx-chart-hist'), results, pane);
      this._drawRoomBars(pane.querySelector('#olx-chart-rooms'), results);
    });
  }

  // ── Outlier clipping ──────────────────────────────────────────────────────

  // ── Histogram ─────────────────────────────────────────────────────────────

  _drawHistogram(canvas, results, pane) {
    if (!canvas) return;

    const vals = results.map(r => r.ppm2).filter(Boolean);
    if (!vals.length) return;

    // iqrClip is defined in shared/utils.js
    const { values: inRange, clipped } = iqrClip(vals);
    const lo = inRange.length ? Math.min(...inRange) : 0;
    const hi = inRange.length ? Math.max(...inRange) : 1;

    // Update subtitle — use pane-scoped query to avoid touching other panes
    const sub = pane ? pane.querySelector('#olx-chart-hist-subtitle') : null;
    if (sub) {
      sub.textContent = clipped > 0
        ? `Prikazano ${vals.length - clipped} od ${vals.length} oglasa (${clipped} outlier${clipped > 1 ? 'a' : ''} izvan IQR raspona isključeno)`
        : `${vals.length} oglasa`;
    }
    if (!inRange.length) return;

    const BINS   = 24;
    const range  = hi - lo || 1;
    const binW   = range / BINS;

    const counts  = new Array(BINS).fill(0);
    const binVals = new Array(BINS).fill(null).map(() => []);  // for IQR whisker data per bin

    for (const v of inRange) {
      const i = Math.min(BINS - 1, Math.floor((v - lo) / binW));
      counts[i]++;
      binVals[i].push(v);
    }

    const maxCount = Math.max(...counts);

    const ctx = canvas.getContext('2d');
    const W   = canvas.width, H = canvas.height;
    const pad = { top: 14, right: 24, bottom: 32, left: 44 };
    const cW  = W - pad.left - pad.right;
    const cH  = H - pad.top  - pad.bottom;

    ctx.clearRect(0, 0, W, H);

    // ── Grid & Y axis (count) ──────────────────────────────────────────────
    const yTicks = niceTicks(0, maxCount, 4);
    ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 1;
    for (const tick of yTicks) {
      const y = pad.top + cH - (tick / maxCount) * cH;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#9ca3af'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
      ctx.fillText(tick, pad.left - 5, y + 3);
    }

    // ── Bars ──────────────────────────────────────────────────────────────
    const bw = cW / BINS;
    for (let i = 0; i < BINS; i++) {
      if (counts[i] === 0) continue;
      const barH = (counts[i] / maxCount) * cH;
      const x    = pad.left + i * bw;
      const y    = pad.top + cH - barH;

      // Colour by tier relative to median
      const midVal = lo + (i + 0.5) * binW;
      const ratio  = this._median ? midVal / this._median : 1;
      ctx.fillStyle = ratio <= 0.80 ? '#6ee7b7'
        : ratio <= 1.00 ? '#a7f3d0'
        : ratio <= 1.20 ? '#fde68a'
        : '#fca5a5';

      ctx.fillRect(x + 1, y, bw - 2, barH);

      // Count label on bars that are tall enough
      if (barH > 14 && counts[i] > 0) {
        ctx.fillStyle = '#374151';
        ctx.font = 'bold 9px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(counts[i], x + bw / 2, y + 10);
      } else if (counts[i] > 0) {
        // Float label above short bars
        ctx.fillStyle = '#6b7280';
        ctx.font = '9px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(counts[i], x + bw / 2, y - 2);
      }
    }

    // ── Median line ────────────────────────────────────────────────────────
    if (this._median && this._median >= lo && this._median <= hi) {
      const mx = pad.left + ((this._median - lo) / range) * cW;
      ctx.strokeStyle = '#002f34';
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(mx, pad.top); ctx.lineTo(mx, pad.top + cH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle   = '#002f34';
      ctx.font        = 'bold 9px system-ui';
      ctx.textAlign   = mx > W / 2 ? 'right' : 'left';
      ctx.fillText(`Medijan ${formatNumber(this._median)}`, mx + (mx > W / 2 ? -5 : 5), pad.top + 10);
    }

    // ── X axis ticks ──────────────────────────────────────────────────────
    const xTicks = niceTicks(lo, hi, 8);
    ctx.fillStyle = '#9ca3af'; ctx.font = '9px system-ui';
    for (const tick of xTicks) {
      const x = pad.left + ((tick - lo) / range) * cW;
      ctx.textAlign = 'center';
      ctx.fillText(formatNumber(Math.round(tick)), x, H - 4);
    }

    // X axis label
    ctx.fillStyle = '#9ca3af'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('KM/m²', W / 2, H);
  }

  // ── Room bar chart ────────────────────────────────────────────────────────

  _drawRoomBars(canvas, results) {
    if (!canvas) return;

    const byRoom = {};
    for (const r of results) {
      const key = normRooms(r.rooms);
      if (key === null) continue;
      if (!byRoom[key]) byRoom[key] = [];
      byRoom[key].push(r.ppm2);
    }

    const order  = ['0', '1', '2', '3', '4+'];
    const labels = { '0': 'Garsonjera', '1': '1-sob', '2': '2-sob', '3': '3-sob', '4+': '4+' };
    const keys   = order.filter(k => byRoom[k]?.length > 0);
    if (!keys.length) return;

    // Per-bucket: clip outliers then compute median, p25, p75 for whiskers
    const buckets = keys.map(k => {
      const all            = byRoom[k].sort((a, b) => a - b);
      const { values: clipped } = iqrClip(all);
      const vals           = clipped.length > 0 ? clipped : all;  // fallback if tiny bucket
      const med            = computeMedian([...vals]);
      const p25            = vals[Math.floor(vals.length * 0.25)];
      const p75            = vals[Math.floor(vals.length * 0.75)];
      return { key: k, med, p25, p75, count: all.length, clippedCount: all.length - clipped.length };
    });

    // Y axis range: across all buckets p25..p75 + some headroom, but anchored at 0
    const allMeds = buckets.map(b => b.med);
    const allP75  = buckets.map(b => b.p75);
    const yMax    = Math.max(...allP75) * 1.15;

    const ctx = canvas.getContext('2d');
    const W   = canvas.width, H = canvas.height;
    const pad = { top: 18, right: 24, bottom: 36, left: 52 };
    const cW  = W - pad.left - pad.right;
    const cH  = H - pad.top  - pad.bottom;

    ctx.clearRect(0, 0, W, H);

    const toY = v => pad.top + cH - (v / yMax) * cH;

    // ── Grid & Y axis ──────────────────────────────────────────────────────
    const yTicks = niceTicks(0, yMax, 4);
    ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 1;
    for (const tick of yTicks) {
      const y = toY(tick);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#9ca3af'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
      ctx.fillText(formatNumber(Math.round(tick)), pad.left - 5, y + 3);
    }

    // ── Bars + whiskers ────────────────────────────────────────────────────
    const step = cW / keys.length;
    const bw   = Math.min(56, step - 16);

    buckets.forEach(({ key, med, p25, p75, count, clippedCount }, i) => {
      const cx  = pad.left + i * step + step / 2;
      const x   = cx - bw / 2;

      // IQR box (p25–p75)
      const yP25 = toY(p25), yP75 = toY(p75), yMed = toY(med);
      const boxH = Math.max(2, yP25 - yP75);

      ctx.fillStyle   = '#dbeafe';
      ctx.strokeStyle = '#93c5fd';
      ctx.lineWidth   = 1;
      ctx.fillRect(x, yP75, bw, boxH);
      ctx.strokeRect(x, yP75, bw, boxH);

      // Median line inside box
      ctx.strokeStyle = '#002f34';
      ctx.lineWidth   = 2;
      ctx.beginPath(); ctx.moveTo(x, yMed); ctx.lineTo(x + bw, yMed); ctx.stroke();

      // Median value label
      ctx.fillStyle   = '#111827';
      ctx.font        = 'bold 10px system-ui';
      ctx.textAlign   = 'center';
      ctx.fillText(formatNumber(Math.round(med)), cx, yP75 - 4);

      // Count label
      ctx.fillStyle = '#6b7280';
      ctx.font      = '9px system-ui';
      ctx.fillText(`n=${count}${clippedCount > 0 ? ` (-${clippedCount})` : ''}`, cx, H - pad.bottom + 12);

      // Room label
      ctx.fillStyle = '#374151';
      ctx.font      = '10px system-ui';
      ctx.fillText(labels[key] || key, cx, H - pad.bottom + 24);
    });

    // ── Median reference line ─────────────────────────────────────────────
    if (this._median) {
      const my = toY(this._median);
      if (my >= pad.top && my <= pad.top + cH) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(pad.left, my); ctx.lineTo(W - pad.right, my); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#b45309'; ctx.font = '9px system-ui'; ctx.textAlign = 'left';
        ctx.fillText(`Ukupni medijan ${formatNumber(this._median)}`, pad.left + 4, my - 3);
      }
    }

    // Y axis label
    ctx.save();
    ctx.translate(10, pad.top + cH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#9ca3af'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('KM/m²', 0, 0);
    ctx.restore();
  }

}
