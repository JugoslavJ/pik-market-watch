// OLX.ba Price per m² — View: Price per m² — configuration tab

class ConfigTab {
  constructor(config, onConfigChange) {
    this._config             = config;
    this._onChange           = onConfigChange;
    this._rentStats          = null;
    this._activePreviewPrice = 150_000;  // tracks price-pick selection across refreshes
  }

  setRentStats(stats) {
    this._rentStats = stats;
    const pane = getElement('olx-config-pane');
    if (pane?.classList.contains('olx-tab-pane-active')) {
      this._refreshOwnedSummary(pane);
    }
  }

  render() {
    const pane = getElement('olx-config-pane');
    if (!pane) return;
    pane.innerHTML = this._buildHTML();
    this._attachListeners(pane);
    this._refreshLoanPreview(pane, this._activePreviewPrice);
    this._refreshOwnedSummary(pane);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  _buildHTML() {
    const c = this._config;
    return `
      <div class="olx-cfg-section">
        <div class="olx-cfg-section-title">Prihodi i kredit</div>

        <div class="olx-cfg-grid">
          <div class="olx-cfg-field">
            <label class="olx-cfg-label" for="olx-cfg-income">Plata (KM)</label>
            <input class="olx-cfg-input" id="olx-cfg-income" type="number" min="0" step="100"
                   value="${c.monthlyIncome}" placeholder="2500">
          </div>
          <div class="olx-cfg-field">
            <label class="olx-cfg-label" for="olx-cfg-max-pct">Maks. rata</label>
            <div class="olx-cfg-input-group">
              <input class="olx-cfg-input" id="olx-cfg-max-pct" type="number" min="10" max="90" step="5"
                     value="${c.maxPaymentPct}">
              <span class="olx-cfg-unit">% plate</span>
            </div>
          </div>
          <div class="olx-cfg-field">
            <label class="olx-cfg-label" for="olx-cfg-down-pct">Avans</label>
            <div class="olx-cfg-input-group">
              <input class="olx-cfg-input" id="olx-cfg-down-pct" type="number" min="0" max="90" step="5"
                     value="${c.downPaymentPct}">
              <span class="olx-cfg-unit">%</span>
            </div>
          </div>
          <div class="olx-cfg-field">
            <label class="olx-cfg-label">Rok kredita</label>
            <div class="olx-cfg-radio-group" id="olx-cfg-term-group">
              ${this._termOptions()}
            </div>
          </div>
        </div>

        <div class="olx-cfg-loan-preview hidden" id="olx-cfg-loan-preview">
          <div class="olx-cfg-preview-title">
            Primjer —
            <span class="olx-cfg-price-picks">
              <button class="olx-cfg-price-btn" data-price="100000">100k</button>
              <button class="olx-cfg-price-btn olx-cfg-price-btn-active" data-price="150000">150k</button>
              <button class="olx-cfg-price-btn" data-price="200000">200k</button>
              <button class="olx-cfg-price-btn" data-price="250000">250k</button>
            </span>
            <span id="olx-cfg-preview-price-label">150.000 KM</span>
          </div>
          <div id="olx-cfg-loan-preview-body"></div>
        </div>
      </div>

      <div class="olx-cfg-section">
        <div class="olx-cfg-section-title">Projekcija (inflacija i rast najma)</div>
        <div class="olx-cfg-hint">Duži krediti postaju "jeftiniji" s inflacijom — kasniji obroci vrijede manje.</div>

        <div class="olx-cfg-grid">
          <div class="olx-cfg-field">
            <label class="olx-cfg-label" for="olx-cfg-rent-growth">Rast najma/god.</label>
            <div class="olx-cfg-input-group">
              <input class="olx-cfg-input" id="olx-cfg-rent-growth" type="number"
                     min="0" max="20" step="0.5" value="${c.rentGrowthRate}">
              <span class="olx-cfg-unit">%</span>
            </div>
          </div>
          <div class="olx-cfg-field">
            <label class="olx-cfg-label" for="olx-cfg-inflation">Inflacija/god.</label>
            <div class="olx-cfg-input-group">
              <input class="olx-cfg-input" id="olx-cfg-inflation" type="number"
                     min="0" max="20" step="0.5" value="${c.inflationRate}">
              <span class="olx-cfg-unit">%</span>
            </div>
          </div>
          <div class="olx-cfg-field">
            <label class="olx-cfg-label" for="olx-cfg-roi-target">Ciljani ROI (min avans)</label>
            <div class="olx-cfg-input-group">
              <input class="olx-cfg-input" id="olx-cfg-roi-target" type="number"
                     min="0" max="20" step="0.5" value="${c.roiTarget}">
              <span class="olx-cfg-unit">%</span>
            </div>
          </div>
        </div>
        <div class="olx-cfg-hint" style="margin-top:4px;">
          Prikazuje ROI u godini 10, realni ROI na kraju, break-even godinu i ukupnu dobit u tabeli. Min avans se računa za ciljani ROI.
        </div>
      </div>

      <div class="olx-cfg-section">
        <div class="olx-cfg-section-header">
          <div class="olx-cfg-section-title">Nekretnine u vlasništvu</div>
          <button class="olx-cfg-add-btn" id="olx-cfg-add-prop">+ Dodaj</button>
        </div>
        <div class="olx-cfg-hint">Prihod od iznajmljivanja povećava budžet za kredit i utiče na ROI.</div>
        <div id="olx-cfg-properties">${this._buildPropertiesList()}</div>
        <div id="olx-cfg-owned-summary"></div>
      </div>`;
  }

  _termOptions() {
    const opts = [
      { value: 'auto', label: 'Auto' },
      { value: '60',   label: '5g' },
      { value: '120',  label: '10g' },
      { value: '180',  label: '15g' },
      { value: '240',  label: '20g' },
    ];
    return opts.map(o => {
      const active = this._config.preferredTerm === o.value ? ' olx-cfg-radio-active' : '';
      return `<button class="olx-cfg-radio-btn${active}" data-term="${o.value}">${o.label}</button>`;
    }).join('');
  }

  _buildPropertiesList() {
    const props = this._config.ownedProperties;
    if (!props.length) {
      return `<div class="olx-cfg-empty">Nema nekretnina. Kliknite "+ Dodaj" da dodate.</div>`;
    }
    return props.map(p => this._buildPropertyRow(p)).join('');
  }

  _buildPropertyRow(p) {
    const roomsVal = p.rooms != null ? p.rooms : '';
    return `
      <div class="olx-cfg-prop-row" data-prop-id="${p.id}">
        <input class="olx-cfg-input olx-cfg-prop-name" type="text"
               placeholder="Naziv" value="${escapeHtml(p.label || '')}"
               data-field="label" data-prop-id="${p.id}">
        <div class="olx-cfg-input-group olx-cfg-prop-sm">
          <input class="olx-cfg-input" type="number" min="10" max="500" step="1"
                 placeholder="m²" value="${p.sqm != null ? p.sqm : ''}"
                 data-field="sqm" data-prop-id="${p.id}">
          <span class="olx-cfg-unit">m²</span>
        </div>
        <div class="olx-cfg-input-group olx-cfg-prop-sm">
          <input class="olx-cfg-input" type="number" min="0" max="10" step="1"
                 placeholder="sob" value="${roomsVal}"
                 data-field="rooms" data-prop-id="${p.id}">
          <span class="olx-cfg-unit">sob</span>
        </div>
        <div class="olx-cfg-input-group olx-cfg-prop-sm">
          <input class="olx-cfg-input" type="number" min="0" step="1000"
                 placeholder="cijena" value="${p.price != null ? p.price : ''}"
                 data-field="price" data-prop-id="${p.id}">
          <span class="olx-cfg-unit">KM</span>
        </div>
        <button class="olx-cfg-delete-btn" data-prop-id="${p.id}" title="Ukloni">✕</button>
      </div>`;
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  _attachListeners(pane) {
    const refresh = () => { this._refreshLoanPreview(pane, this._activePreviewPrice); this._refreshOwnedSummary(pane); this._onChange(); };
    const refreshLoan = () => { this._refreshLoanPreview(pane, this._activePreviewPrice); this._onChange(); };

    pane.querySelector('#olx-cfg-loan-preview').addEventListener('click', e => {
      const btn = e.target.closest('.olx-cfg-price-btn');
      if (!btn) return;
      pane.querySelectorAll('.olx-cfg-price-btn').forEach(b => b.classList.toggle('olx-cfg-price-btn-active', b === btn));
      this._activePreviewPrice = Number(btn.dataset.price);
      const label = pane.querySelector('#olx-cfg-preview-price-label');
      if (label) label.textContent = formatNumber(this._activePreviewPrice) + ' KM';
      this._refreshLoanPreview(pane, this._activePreviewPrice);
    });

    pane.querySelector('#olx-cfg-income').addEventListener('change', e => {
      this._config.monthlyIncome = Number(e.target.value); refresh();
    });
    pane.querySelector('#olx-cfg-max-pct').addEventListener('change', e => {
      this._config.maxPaymentPct = Number(e.target.value); refresh();
    });
    pane.querySelector('#olx-cfg-down-pct').addEventListener('change', e => {
      this._config.downPaymentPct = Number(e.target.value); refreshLoan();
    });
    pane.querySelector('#olx-cfg-rent-growth').addEventListener('change', e => {
      this._config.rentGrowthRate = Number(e.target.value); this._onChange();
    });
    pane.querySelector('#olx-cfg-inflation').addEventListener('change', e => {
      this._config.inflationRate = Number(e.target.value); this._onChange();
    });
    pane.querySelector('#olx-cfg-roi-target').addEventListener('change', e => {
      this._config.roiTarget = Number(e.target.value); this._onChange();
    });
    pane.querySelector('#olx-cfg-term-group').addEventListener('click', e => {
      const btn = e.target.closest('.olx-cfg-radio-btn');
      if (!btn) return;
      this._config.preferredTerm = btn.dataset.term;
      pane.querySelectorAll('.olx-cfg-radio-btn').forEach(b =>
        b.classList.toggle('olx-cfg-radio-active', b === btn));
      refreshLoan();
    });
    pane.querySelector('#olx-cfg-add-prop').addEventListener('click', () => {
      this._config.addProperty({ label: '', sqm: null, rooms: null });
      this._rebuildPropertiesList(pane);
      this._refreshOwnedSummary(pane);
      this._onChange();
    });
    pane.querySelector('#olx-cfg-properties').addEventListener('input', e => {
      const input = e.target.closest('input[data-prop-id]');
      if (!input) return;
      const { propId, field } = input.dataset;
      const val = field === 'label' ? input.value
                : input.value.trim() === '' ? null : Number(input.value);
      this._config.updateProperty(propId, { [field]: val });
      refresh();
    });
    pane.querySelector('#olx-cfg-properties').addEventListener('click', e => {
      const btn = e.target.closest('.olx-cfg-delete-btn');
      if (!btn) return;
      this._config.removeProperty(btn.dataset.propId);
      this._rebuildPropertiesList(pane);
      this._refreshOwnedSummary(pane);
      this._onChange();
    });
  }

  _rebuildPropertiesList(pane) {
    pane.querySelector('#olx-cfg-properties').innerHTML = this._buildPropertiesList();
  }

  // ── Owned income summary ──────────────────────────────────────────────────

  _refreshOwnedSummary(pane) {
    const el = pane.querySelector('#olx-cfg-owned-summary');
    if (!el) return;
    const props = this._config.ownedProperties;
    if (!props.length || !this._rentStats) { el.innerHTML = ''; return; }

    const rows = props.map(p => {
      const label  = p.label || `${p.sqm ?? '?'} m²${p.rooms != null ? ' / ' + (p.rooms === 0 ? 'garsonjera' : p.rooms + ' sob') : ''}`;
      const result = estimateRent(p.rooms, p.sqm, this._rentStats);
      const minDown = p.price && result.est
        ? this._config.minDownForROI(p.price, result.est)
        : null;
      return { label, est: result.est, method: result.method, neighbours: result.neighbours, minDown, price: p.price };
    });

    const totalIncome      = rows.reduce((s, r) => s + (r.est || 0), 0);
    const maxPayment       = Math.round(this._config.monthlyIncome * this._config.maxPaymentPct / 100);
    const budgetWithIncome = maxPayment + totalIncome;

    el.innerHTML = `
      <div class="olx-cfg-owned-summary">
        <div class="olx-cfg-preview-title">Procijenjeni prihod od najma</div>
        <div class="olx-cfg-income-grid">
          ${rows.map(r => {
            let minDownHtml = '';
            if (r.minDown && r.price) {
              const targetPct = this._config.roiTarget ?? 0;
              const targetLabel = targetPct > 0 ? `${targetPct}% ROI` : '0% ROI (break-even)';
              if (r.minDown.feasible && r.minDown.downPct > 0) {
                minDownHtml = `<span class="olx-cfg-owned-method" style="color:#6b7280;">Min avans ${targetLabel}: ${formatNumber(Math.round(r.minDown.downPayment))} KM (${r.minDown.downPct.toFixed(0)}%)</span>`;
              } else if (r.minDown.feasible) {
                minDownHtml = `<span class="olx-cfg-owned-method" style="color:#10b981;">Najam pokriva kredit čak i bez avansa ✓</span>`;
              } else {
                minDownHtml = `<span class="olx-cfg-owned-method" style="color:#ef4444;">Najam ne pokriva kredit (ni uz maks avans)</span>`;
              }
            }
            return `
              <div class="olx-cfg-income-cell">
                <div class="olx-cfg-income-top">
                  <span class="olx-cfg-owned-label">${escapeHtml(r.label)}</span>
                  <span class="olx-cfg-owned-est">${r.est != null ? '~' + formatNumber(r.est) + ' KM/mj' : '—'}</span>
                </div>
                <div class="olx-cfg-income-meta">
                  <span class="olx-cfg-owned-method">${escapeHtml(r.method)}</span>
                  ${r.neighbours.length > 1 ? r.neighbours.map(n =>
                    `<span class="olx-cfg-owned-neighbour">${n.sqm}m²→${formatNumber(n.price)}</span>`
                  ).join('') : ''}
                  ${minDownHtml}
                </div>
              </div>`;
          }).join('')}
        </div>
        <div class="olx-cfg-owned-totals">
          <span>Najam ukupno: <strong>~${formatNumber(Math.round(totalIncome))} KM/mj</strong></span>
          <span class="olx-cfg-owned-budget">Budžet za kredit: <strong>${formatNumber(maxPayment)} + ${formatNumber(Math.round(totalIncome))} = ${formatNumber(Math.round(budgetWithIncome))} KM/mj</strong></span>
        </div>
      </div>`;
  }

  // ── Loan preview ──────────────────────────────────────────────────────────

  _refreshLoanPreview(pane, samplePrice = 150_000) {
    // Use pane-scoped querySelector so we never accidentally touch another pane's elements
    const preview = pane.querySelector('#olx-cfg-loan-preview');
    const body    = pane.querySelector('#olx-cfg-loan-preview-body');
    if (!preview || !body) return;

    const loan       = this._config.selectLoan(samplePrice, 0);
    const maxPayment = Math.round(this._config.monthlyIncome * this._config.maxPaymentPct / 100);
    const ty         = Math.floor(loan.term / 12);
    const tm         = loan.term % 12;
    const termLabel  = tm > 0 ? `${ty}g ${tm}mj` : `${ty}g`;

    preview.classList.remove('hidden');
    body.innerHTML = `
      <div class="olx-cfg-preview-grid">
        <div class="olx-cfg-preview-item">
          <span class="olx-cfg-preview-label">Avans (${this._config.downPaymentPct}%)</span>
          <span class="olx-cfg-preview-val">${formatNumber(loan.downPayment)} KM</span>
        </div>
        <div class="olx-cfg-preview-item">
          <span class="olx-cfg-preview-label">Kredit</span>
          <span class="olx-cfg-preview-val">${formatNumber(Math.round(loan.principal))} KM</span>
        </div>
        <div class="olx-cfg-preview-item">
          <span class="olx-cfg-preview-label">Rok</span>
          <span class="olx-cfg-preview-val">${termLabel}</span>
        </div>
        <div class="olx-cfg-preview-item">
          <span class="olx-cfg-preview-label">Nom. / efekt.</span>
          <span class="olx-cfg-preview-val">${(loan.nominalRate*100).toFixed(2)}% / ${(loan.effectiveRate*100).toFixed(2)}%</span>
        </div>
        <div class="olx-cfg-preview-item olx-cfg-preview-highlight">
          <span class="olx-cfg-preview-label">Rata</span>
          <span class="olx-cfg-preview-val">${formatNumber(Math.round(loan.payment))} KM/mj</span>
        </div>
        <div class="olx-cfg-preview-item">
          <span class="olx-cfg-preview-label">Budžet</span>
          <span class="olx-cfg-preview-val ${!loan.fitsBudget ? 'olx-cfg-preview-over' : 'olx-cfg-preview-ok'}">
            ${formatNumber(maxPayment)} KM ${!loan.fitsBudget ? '⚠' : '✓'}
          </span>
        </div>
      </div>`;
  }
}
