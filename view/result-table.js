// OLX.ba Price per m² — View: Price per m² — sortable, filterable results table

class ResultTable {
  constructor(db) {
    this._sortKey     = 'ppm2';
    this._sortDir     = 1;
    this._pending     = false;
    this._median      = null;
    this._db          = db;
    this._results     = [];
    this._rentStats   = null;
    this._config      = null;
    this._expandedId  = null;
    this._roomFilter  = 'all';
    this._onDaysReady = null;
    this._soldListings = [];
    this._prefetchGen = 0;      // incremented on each render(); stale prefetches self-cancel
  }

  /** Set a callback to be called after IDB prefetch enriches results with days/trend. */
  setOnDaysReady(fn) { this._onDaysReady = fn; }

  setMedian(v)   { this._median = v; }
  setConfig(cfg) {
    this._config = cfg;
    this._scheduleRerender();
  }

  setSoldListings(recs) {
    this._soldListings = recs || [];
    this._scheduleRerender();
  }

  setRentStats(stats) {
    this._rentStats = stats;
    this._updateROIForResults();

    this._scheduleRerender();
  }

  _scheduleRerender() {
    if (!this._results || !this._results.length) return;
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => { this._pending = false; this._doRender(); });
  }

  /** Public alias so external callers (sort callback) don't need the _ prefix */
  rerender() { this._scheduleRerender(); }

  attachSortListener() {
    document.querySelector('#olx-results-table thead').addEventListener('click', e => {
      const th = e.target.closest('th[data-k]');
      if (!th || th.dataset.k === 'spark') return;
      if (this._sortKey === th.dataset.k) this._sortDir *= -1;
      else { this._sortKey = th.dataset.k; this._sortDir = 1; }
      this.rerender();
    });
  }

  attachRoomFilterListener() {
    const bar = getElement('olx-room-filter');
    if (!bar) return;
    bar.addEventListener('click', e => {
      const btn = e.target.closest('.olx-filter-btn');
      if (!btn) return;
      this._roomFilter = btn.dataset.room;
      this._rebuildRoomFilterBar();
      this._scheduleRerender();
    });
  }

  render(results) {
    // Shallow-clone into plain extension-realm objects so _updateROIForResults()
    // can safely assign object-valued properties (XrayWrapper fix).
    this._results = results.map(r => ({ ...r }));
    this._prefetchGen++;                    // invalidate any in-flight prefetch
    this._updateROIForResults();
    this._rebuildRoomFilterBar();
    this._scheduleRerender();
    this._prefetchDbData(this._prefetchGen); // pass current gen as token
  }

  /**
   * Batch-load IDB data once and write days, trend, _priceHistory directly onto
   * this._results so they're available for sorting and for CSV export.
   * When loading completes a re-render is triggered — the sort comparator and
   * applyDbData() in _doRender() both use these pre-populated fields.
   * @param {number} gen — generation token; if it doesn't match this._prefetchGen on
   *                       completion, a newer render() has superseded this call.
   */
  async _prefetchDbData(gen) {
    if (!this._db || !this._results.length) return;
    const resultMap = new Map(
      this._results.map(r => [extractArticleId(r.url), r]).filter(([k]) => k)
    );
    if (!resultMap.size) return;
    try {
      const dbMap = await this._db.getListingsBatch([...resultMap.keys()]);
      // Discard results if a newer render() has already replaced _results
      if (gen !== this._prefetchGen) return;
      let changed = false;
      for (const [id, rec] of dbMap) {
        const r = resultMap.get(id);
        if (!r) continue;
        if (rec.firstSeen) {
          r.days = Math.max(1, Math.round((Date.now() - rec.firstSeen) / 86_400_000));
          changed = true;
        }
        const ppm2vals = (rec.priceHistory || []).map(h => h.ppm2).filter(Boolean);
        r._priceHistory = rec.priceHistory || [];
        if (ppm2vals.length >= 2) {
          const chg = (ppm2vals[ppm2vals.length - 1] - ppm2vals[0]) / ppm2vals[0];
          r.trend   = chg > 0.02 ? 'up' : chg < -0.02 ? 'down' : 'flat';
          changed   = true;
        }
      }
      if (changed) {
        this._scheduleRerender();
        if (this._onDaysReady) this._onDaysReady(this._results);
      }
    } catch {}
  }

  clear() {
    const tbody = getElement('olx-results-tbody');
    if (tbody) tbody.innerHTML = '';
    hideEl('olx-results-table-wrap');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _filteredResults() {
    if (this._roomFilter === 'all') return this._results;
    // normRooms returns null for unknown rooms; those never match any room filter key
    return this._results.filter(r => (normRooms(r.rooms) ?? 'unknown') === this._roomFilter);
  }

  _rebuildRoomFilterBar() {
    const bar = getElement('olx-room-filter');
    if (!bar) return;
    const counts = { all: this._results.length };
    for (const r of this._results) {
      const k = normRooms(r.rooms) ?? 'unknown';
      counts[k] = (counts[k] || 0) + 1;
    }
    const slots = [
      { key: 'all', label: 'Sve' },
      { key: '0',   label: 'Garsonjera' },
      { key: '1',   label: '1-sob' },
      { key: '2',   label: '2-sob' },
      { key: '3',   label: '3-sob' },
      { key: '4+',  label: '4+' },
    ];
    bar.innerHTML = slots
      .filter(s => s.key === 'all' || (counts[s.key] || 0) > 0)
      .map(s => {
        const active = this._roomFilter === s.key ? ' olx-filter-active' : '';
        const cnt    = s.key !== 'all' ? ` <span class="olx-filter-count">${counts[s.key] || 0}</span>` : '';
        return `<button class="olx-filter-btn${active}" data-room="${s.key}">${s.label}${cnt}</button>`;
      }).join('');
  }

  /**
   * Delegates to model/rent-estimator.js estimateRent()
   * so that result-table and config-tab use identical logic.
   */
  _estimatePotRent(rooms, sqm) {
    return estimateRent(rooms, sqm, this._rentStats).est;
  }

  /** Like _estimatePotRent but returns both est and method string. */
  _estimateRentFull(rooms, sqm) {
    return estimateRent(rooms, sqm, this._rentStats);
  }

  _updateROIForResults() {
    if (!this._results) return;

    const cfg = this._config;
    const rentGrowth  = cfg ? cfg.rentGrowthRate / 100 : 0.03;
    const inflation   = cfg ? cfg.inflationRate  / 100 : 0.03;

    // Compute potential rent income from owned properties (using same estimation logic)
    let ownedRentIncome = 0;
    if (cfg && this._rentStats) {
      for (const prop of cfg.ownedProperties) {
        const est = this._estimatePotRent(prop.rooms, prop.sqm);
        if (est) ownedRentIncome += est;
      }
    }

    for (const r of this._results) {
      r.potRent         = null;
      r.roi             = null;
      r.loanTerm        = null;
      r.loanPayment     = null;
      r.downPayment     = null;
      r.loanRentTerm    = null;
      r.loanRentPayment = null;
      r.roiRent         = null;
      r.minDownForROI   = null;   // { downPayment, downPct, feasible }
      // Inflation-aware projections
      r.breakEvenYears  = null;
      r.roiY10          = null;
      r.realRoiAtEnd    = null;

      if (r.isRent || !r.price) continue;

      const rentEst = this._estimateRentFull(r.rooms, r.sqm);
      r.potRent       = rentEst.est;
      r.potRentMethod = rentEst.method || null;

      if (cfg) {
        // Loan A — budget-optimal: lowest total interest within salary budget
        const loan = cfg.selectLoan(r.price, ownedRentIncome);
        r.loanTerm    = loan.term;
        r.loanPayment = loan.payment;
        r.downPayment = loan.downPayment;

        if (r.potRent != null) {
          const netAnnual = (r.potRent - loan.payment) * 12;
          r.roi = (netAnnual / r.price) * 100;

          // Inflation projections for Loan A
          const inf = LoanCalculator.inflationMetrics(r.price, loan.payment, r.potRent, loan.term, rentGrowth, inflation);
          r.breakEvenYears = inf.breakEvenYears;
          r.roiY10         = inf.roiY10;
          r.realRoiAtEnd   = inf.realRoiAtEnd;

          // Total nominal profit over loan term
          r.totalProfit = LoanCalculator.totalNominalProfit(r.potRent, loan.payment, loan.term, rentGrowth);
        }

        // Loan B — rent-optimal: 240 months (min payment), only if rent covers it
        if (r.potRent != null) {
          const loanRent = cfg.selectLoanRent(r.price);
          if (r.potRent > loanRent.payment) {
            r.loanRentTerm    = loanRent.term;
            r.loanRentPayment = loanRent.payment;
            r.roiRent         = ((r.potRent - loanRent.payment) * 12 / r.price) * 100;
            r.totalProfitRent = LoanCalculator.totalNominalProfit(r.potRent, loanRent.payment, loanRent.term, rentGrowth);
          } else {
            // Rent doesn't cover 240m loan — compute how much down would be needed
            r.minDownForROI = cfg.minDownForROI(r.price, r.potRent);
          }
        }
      } else if (r.potRent != null) {
        // No config: gross yield only
        r.roi = (r.potRent * 12 / r.price) * 100;
        // Still show min-down hint using LoanCalculator directly
        r.minDownForROI = LoanCalculator.minDownPaymentForROI(r.price, r.potRent);
      }
    }
  }

  _doRender() {
    const tbody = getElement('olx-results-tbody');
    if (!tbody) return;

    const sorted = [...this._filteredResults()].sort((a, b) => {
      let av = a[this._sortKey], bv = b[this._sortKey];
      if (this._sortKey === 'roi')  { av = a.roi  ?? -Infinity; bv = b.roi  ?? -Infinity; }
      if (this._sortKey === 'days') { av = a.days ?? Infinity;  bv = b.days ?? Infinity;  }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * this._sortDir;
    });

    const frag = document.createDocumentFragment();
    for (const r of sorted) {
      const tier = r.isRent ? '' : getPriceColourTier(r.ppm2, this._median);
      const tr   = document.createElement('tr');
      tr.dataset.articleId = extractArticleId(r.url) || '';

      let badges = '';
      if (r.isNew)     badges += '<span class="olx-badge olx-badge-new">Novo</span>';
      if (r.priceDrop) badges += `<span class="olx-badge olx-badge-drop">↓ ${r.dropPct != null ? r.dropPct + '%' : '↓'}</span>`;
      if (r.priceDrop) tr.classList.add('olx-row-price-drop');
      if (r.isNew)     tr.classList.add('olx-row-new');

      let potRentHtml = '—';
      if (r.isRent) {
        potRentHtml = '<span class="olx-badge olx-badge-rent" style="margin:0">Najam</span>';
      } else if (r.roi != null || r.potRent != null) {
        const rentTitle = r.potRentMethod ? ` title="Procjena najma: ${escapeHtml(r.potRentMethod)}"` : '';
        const rentLine = `<div style="font-weight:600;line-height:1.3;"${rentTitle}>~${formatNumber(Math.round(r.potRent))} KM</div>`;

        // Loan A — budget-optimal
        let loanALine = '';
        if (r.loanTerm) {
          const c = roiColour(r.roi);
          const termYears = Math.round(r.loanTerm / 12);
          loanALine = `<div style="font-size:10px;font-weight:600;color:${c};">${r.roi.toFixed(1)}% ROI</div>`
            + `<div style="font-size:9px;color:#9ca3af;">${fmtTerm(r.loanTerm)} · ${formatNumber(Math.round(r.loanPayment))} KM/mj</div>`;

          // Y10 projection with assumptions in tooltip
          if (r.roiY10 != null && Math.abs(r.roiY10 - r.roi) > 0.3) {
            const c10    = roiColour(r.roiY10);
            const cfgHint = this._config
              ? `rast najma ${this._config.rentGrowthRate}%/god, inflacija ${this._config.inflationRate}%/god`
              : 'rast najma 3%/god, inflacija 3%/god';
            loanALine += `<div style="font-size:9px;color:${c10};margin-top:2px;" title="${cfgHint}">→ Y10: ${r.roiY10.toFixed(1)}%`;
            // Real ROI at end of loan (inflation-discounted payment)
            if (r.realRoiAtEnd != null) {
              const cReal = roiColour(r.realRoiAtEnd);
              loanALine += ` / <span style="color:${cReal};">Y${termYears}r: ${r.realRoiAtEnd.toFixed(1)}%</span>`;
            }
            loanALine += `</div>`;
          }

          // Break-even label (only when currently cash-flow negative)
          if (r.roi < 0 && r.breakEvenYears != null && isFinite(r.breakEvenYears) && r.breakEvenYears < r.loanTerm / 12) {
            const be = r.breakEvenYears;
            const beLabel = be < 1 ? `${Math.ceil(be * 12)}mj` : `${be.toFixed(1)}g`;
            loanALine += `<div style="font-size:9px;color:#f59e0b;">break-even: ${beLabel}</div>`;
          }

          // Total nominal profit over loan term
          if (r.totalProfit != null) {
            const tpClr = r.totalProfit >= 0 ? '#10b981' : '#ef4444';
            const tpKm  = (r.totalProfit >= 0 ? '+' : '') + formatNumber(Math.round(r.totalProfit));
            loanALine += `<div style="font-size:9px;color:${tpClr};margin-top:1px;" title="Ukupna nominalna dobit za ${fmtTerm(r.loanTerm)}">${tpKm} KM ukupno</div>`;
          }
        }

        // Loan B — rent-covers-loan (only shown if profitable)
        let loanBLine = '';
        if (r.loanRentTerm) {
          loanBLine = `<div style="font-size:10px;font-weight:600;color:#10b981;margin-top:3px;">${r.roiRent.toFixed(1)}% ROI najam</div>`
            + `<div style="font-size:9px;color:#9ca3af;">${fmtTerm(r.loanRentTerm)} · ${formatNumber(Math.round(r.loanRentPayment))} KM/mj</div>`;
          if (r.totalProfitRent != null) {
            const km = (r.totalProfitRent >= 0 ? '+' : '') + formatNumber(Math.round(r.totalProfitRent));
            const clr = r.totalProfitRent >= 0 ? '#10b981' : '#ef4444';
            loanBLine += `<div style="font-size:9px;color:${clr};">${km} KM ukupno</div>`;
          }
        } else if (r.minDownForROI) {
          const md  = r.minDownForROI;
          const tgt = this._config ? (this._config.roiTarget ?? 0) : 0;
          const tgtLabel = tgt > 0 ? `${tgt}%` : '0%';
          if (md.feasible) {
            const pct = md.downPct.toFixed(0);
            const km  = formatNumber(Math.round(md.downPayment));
            loanBLine = `<div style="font-size:9px;color:#9ca3af;margin-top:3px;">Min avans za ${tgtLabel} ROI:</div>`
              + `<div style="font-size:10px;font-weight:600;color:#6b7280;">${km} KM (${pct}%)</div>`;
          } else {
            loanBLine = `<div style="font-size:9px;color:#9ca3af;margin-top:3px;">Najam ne pokriva kredit</div>`;
          }
        }

        potRentHtml = rentLine + loanALine + loanBLine;
      }

      tr.innerHTML = `
        <td class="olx-td-title" title="${escapeHtml(r.title)}">
          ${badges}<a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.title)}</a>
        </td>
        <td>${formatNumber(r.sqm)}</td>
        <td>${r.rooms || '—'}</td>
        <td>${r.price ? formatNumber(r.price) : (r.priceText || '—')}</td>
        <td class="olx-ppm2-cell ${tier}">${r.isRent ? '—' : formatNumber(r.ppm2)}</td>
        <td class="olx-roi-cell">${potRentHtml}</td>
        <td class="olx-days-cell"></td>
        <td class="olx-spark-cell"></td>`;
      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
    const rows = tbody.querySelectorAll('tr');

    // Build O(1) lookup from pre-fetched data (_prefetchDbData already ran)
    const resultMap = new Map(
      this._results.map(r => [extractArticleId(r.url), r]).filter(([k]) => k)
    );

    for (const tr of rows) {
      const articleId = tr.dataset.articleId;
      const sparkCell = tr.querySelector('.olx-spark-cell');
      const daysCell  = tr.querySelector('.olx-days-cell');
      const r         = resultMap.get(articleId);

      if (r) {
        // Sparkline from pre-fetched priceHistory
        const ppm2vals = (r._priceHistory || []).map(h => h.ppm2).filter(Boolean);
        if (ppm2vals.length) sparkCell.appendChild(Sparkline.render(ppm2vals));

        // Trend indicator (direction already computed in _prefetchDbData)
        if (r.trend) {
          const [icon, clr] = r.trend === 'up'   ? ['↑', '#ef4444']
                            : r.trend === 'down'  ? ['↓', '#10b981']
                            :                       ['→', '#9ca3af'];
          const chgPct = ppm2vals.length >= 2
            ? ((ppm2vals[ppm2vals.length-1] - ppm2vals[0]) / ppm2vals[0] * 100).toFixed(1)
            : null;
          const ind = document.createElement('span');
          ind.textContent = icon;
          ind.style.cssText = `font-size:10px;font-weight:700;color:${clr};margin-left:3px;`;
          if (chgPct) ind.title = `${Number(chgPct) >= 0 ? '+' : ''}${chgPct}% od prvog oglašavanja`;
          sparkCell.appendChild(ind);
        }

        // Days (pre-fetched; also used for sorting)
        if (r.days) {
          daysCell.textContent = r.days;
          if      (r.days <= 3)  daysCell.className = 'olx-days-cell olx-days-fresh';
          else if (r.days >= 90) daysCell.className = 'olx-days-cell olx-days-old';
          else if (r.days >= 30) daysCell.className = 'olx-days-cell olx-days-stale';
        }
      }

      tr.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        this._toggleHistoryRow(tr, articleId);
      });
    }

    // Re-open history row if it was expanded before re-render
    if (this._expandedId) {
      const targetTr = tbody.querySelector(`tr[data-article-id="${CSS.escape(this._expandedId)}"]`);
      if (targetTr) this._toggleHistoryRow(targetTr, this._expandedId);
    }

    this._renderSoldSection();

    showEl('olx-results-table-wrap');
    this._updateHeaders();
    this._updateBulkBar(sorted);
  }

  /** Renders sold / removed listings below the main table as price anchors. */
  _renderSoldSection() {
    const SOLD_ID = 'olx-sold-section';
    let section   = getElement(SOLD_ID);

    const sold = (this._soldListings || []).filter(r => !r.isRent && r.ppm2);
    if (!sold.length) {
      if (section) section.style.display = 'none';
      return;
    }

    if (!section) {
      section = document.createElement('div');
      section.id = SOLD_ID;
      section.style.cssText = 'margin-top:16px;opacity:0.72;';
      const wrap = getElement('olx-results-table-wrap');
      if (wrap) wrap.insertAdjacentElement('afterend', section);
      else return;
    }
    section.style.display = '';

    // Sort sold by soldAt desc (most recently sold first)
    const sortedSold = [...sold].sort((a, b) => (b.soldAt || 0) - (a.soldAt || 0));

    const rows = sortedSold.map(r => {
      const tier   = getPriceColourTier(r.ppm2, this._median);
      const daysAgo = r.soldAt
        ? Math.max(1, Math.round((Date.now() - r.soldAt) / 86_400_000))
        : null;
      const ppm2vals = (r.priceHistory || []).map(h => h.ppm2).filter(Boolean);
      const history  = ppm2vals.length >= 2
        ? `<span style="font-size:10px;color:#9ca3af;"> (${ppm2vals[0]}→${ppm2vals[ppm2vals.length-1]})</span>`
        : '';
      return `<tr style="color:#6b7280;">
        <td style="padding:4px 6px;font-size:11px;" title="${escapeHtml(r.title || '')}">
          <span style="background:#fee2e2;color:#991b1b;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:4px;">Prodato</span>
          <a href="${escapeHtml(r.url)}" target="_blank" style="color:#9ca3af;text-decoration:none;">${escapeHtml(r.title || r.url)}</a>
        </td>
        <td style="padding:4px 6px;font-size:11px;">${r.sqm ? formatNumber(r.sqm) : '—'}</td>
        <td style="padding:4px 6px;font-size:11px;">${r.rooms || '—'}</td>
        <td style="padding:4px 6px;font-size:11px;">${r.price ? formatNumber(r.price) : '—'}</td>
        <td style="padding:4px 6px;font-size:11px;" class="olx-ppm2-cell ${tier}">${formatNumber(r.ppm2)}${history}</td>
        <td style="padding:4px 6px;font-size:11px;" colspan="3">${daysAgo != null ? `Prodato prije ${daysAgo}d` : ''}</td>
      </tr>`;
    }).join('');

    section.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:4px;padding-left:2px;">
        Prodato / uklonjeno (${sortedSold.length}) — cjenovni ankeri
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="color:#9ca3af;border-bottom:1px solid #e5e7eb;">
            <th style="text-align:left;padding:2px 6px;font-weight:500;">Oglas</th>
            <th style="padding:2px 6px;font-weight:500;">m²</th>
            <th style="padding:2px 6px;font-weight:500;">Sobe</th>
            <th style="padding:2px 6px;font-weight:500;">Cijena</th>
            <th style="padding:2px 6px;font-weight:500;">KM/m²</th>
            <th style="padding:2px 6px;font-weight:500;" colspan="3">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /** Renders a small action bar with count + copy-URLs + open-5 buttons */
  _updateBulkBar(sorted) {
    let bar = getElement('olx-bulk-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'olx-bulk-bar';
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;';
      const wrap = getElement('olx-results-table-wrap');
      if (wrap) wrap.insertAdjacentElement('beforebegin', bar);
    }

    const visible = sorted.filter(r => !r.isRent);
    if (!visible.length) { bar.innerHTML = ''; return; }

    const salesUrls = visible.map(r => r.url).filter(Boolean);
    const top5      = salesUrls.slice(0, 5);

    bar.innerHTML = `
      <span style="font-size:11px;color:#6b7280;">${visible.length} prikazano</span>
      <button id="olx-bulk-copy"
        style="all:unset;cursor:pointer;font-size:11px;font-weight:600;color:#374151;
               background:#f3f4f6;padding:4px 10px;border-radius:6px;transition:background .15s;"
        title="Kopiraj URL-ove svih prikazanih oglasa u clipboard">
        📋 Kopiraj URL-ove
      </button>
      <button id="olx-bulk-open"
        style="all:unset;cursor:pointer;font-size:11px;font-weight:600;color:#374151;
               background:#f3f4f6;padding:4px 10px;border-radius:6px;transition:background .15s;"
        title="Otvori prvih ${top5.length} oglasa u novim tabovima">
        ↗ Otvori prvih ${top5.length}
      </button>`;

    bar.querySelector('#olx-bulk-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(salesUrls.join('\n')).then(() => {
        const btn = bar.querySelector('#olx-bulk-copy');
        const orig = btn.textContent;
        btn.textContent = '✓ Kopirano!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    });

    bar.querySelector('#olx-bulk-open').addEventListener('click', () => {
      // window.open() in a loop is blocked as popups after the first.
      // Route through background.js which has the tabs permission.
      browser.runtime.sendMessage({ type: 'OPEN_TABS', urls: top5 }).catch(() => {
        // Fallback: at least open the first one directly
        if (top5.length) window.open(top5[0], '_blank', 'noopener');
      });
    });
  }

  _toggleHistoryRow(tr, articleId) {
    const existing = getElement('olx-history-row');
    if (existing) {
      existing.remove();
      const wasSelected = tr.classList.contains('olx-row-selected');
      document.querySelectorAll('#olx-results-tbody tr').forEach(r => r.classList.remove('olx-row-selected'));
      if (wasSelected) { this._expandedId = null; return; }
    } else {
      document.querySelectorAll('#olx-results-tbody tr').forEach(r => r.classList.remove('olx-row-selected'));
    }

    if (!articleId || !this._db) return;
    this._expandedId = articleId;
    tr.classList.add('olx-row-selected');

    this._db.getListing(articleId).then(rec => {
      const historyTr = document.createElement('tr');
      historyTr.id        = 'olx-history-row';
      historyTr.className = 'olx-history-row';

      const td = document.createElement('td');
      td.colSpan = 8;

      if (!rec || rec.priceHistory.length <= 1) {
        td.innerHTML = `<div class="olx-history-inner">
          <span class="olx-history-label">Nema historije cijena za ovaj oglas.</span>
        </div>`;
      } else {
        const history = rec.priceHistory;
        const canvas  = document.createElement('canvas');
        canvas.width  = 560;
        canvas.height = 80;
        canvas.style.cssText = 'width:100%;height:80px;display:block;';
        td.innerHTML = `<div class="olx-history-inner">
          <span class="olx-history-label">Historija cijena<br>(${history.length} ta\u010daka)</span>
          <div class="olx-history-canvas-wrap"></div>
        </div>`;
        td.querySelector('.olx-history-canvas-wrap').appendChild(canvas);
        requestAnimationFrame(() => this._drawHistoryChart(canvas, history));
      }

      historyTr.appendChild(td);
      tr.insertAdjacentElement('afterend', historyTr);
    }).catch(() => {});
  }

  _drawHistoryChart(canvas, history) {
    const ctx  = canvas.getContext('2d');
    const W    = canvas.width, H = canvas.height;
    const pad  = { top: 10, right: 10, bottom: 24, left: 52 };
    const cW   = W - pad.left - pad.right;
    const cH   = H - pad.top  - pad.bottom;

    const ppm2Vals = history.map(h => h.ppm2).filter(Boolean);
    if (ppm2Vals.length === 0) return;

    const minV   = Math.min(...ppm2Vals);
    const maxV   = Math.max(...ppm2Vals);
    const rangeV = maxV - minV || 1;

    const toX = i => pad.left + (i / Math.max(history.length - 1, 1)) * cW;
    const toY = v => pad.top  + (1 - (v - minV) / rangeV) * cH;

    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = '#f0f0f0';
    ctx.lineWidth   = 1;
    for (let tick = 0; tick <= 4; tick++) {
      const y = pad.top + (tick / 4) * cH;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      const label = formatNumber(Math.round(maxV - (tick / 4) * rangeV));
      ctx.fillStyle = '#9ca3af';
      ctx.font      = '9px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(label, pad.left - 4, y + 3);
    }

    ctx.strokeStyle = '#002f34';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    history.forEach((h, i) => {
      if (h.ppm2 == null) return;
      i === 0 ? ctx.moveTo(toX(i), toY(h.ppm2)) : ctx.lineTo(toX(i), toY(h.ppm2));
    });
    ctx.stroke();

    history.forEach((h, i) => {
      if (h.ppm2 == null) return;
      ctx.fillStyle = '#002f34';
      ctx.beginPath();
      ctx.arc(toX(i), toY(h.ppm2), 3, 0, Math.PI * 2);
      ctx.fill();

      if (i === 0 || i === history.length - 1 || history.length <= 5) {
        const d     = new Date(h.scrapedAt);
        const label = `${d.getDate()}.${d.getMonth() + 1}.`;
        ctx.fillStyle = '#9ca3af';
        ctx.font      = '9px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(label, toX(i), H - 4);
      }
    });
  }

  _updateHeaders() {
    for (const th of document.querySelectorAll('#olx-results-table thead th[data-k]')) {
      if (th.dataset.k === 'spark') continue;
      const arrow = th.dataset.k === this._sortKey
        ? (this._sortDir === 1 ? ' \u25b2' : ' \u25bc') : '';
      th.textContent = th.dataset.label + arrow;
    }
  }
}
