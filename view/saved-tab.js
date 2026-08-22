// OLX.ba Price per m² — View: saved searches tab

class SavedTab {
  /**
   * @param {ListingsDatabase} db
   * @param {string}           currentSearchKey — key for the currently viewed search
   * @param {string}           currentUrl       — URL of the currently viewed search
   */
  constructor(db, currentSearchKey, currentUrl) {
    this._db               = db;
    this._currentSearchKey = currentSearchKey;
    this._currentUrl       = currentUrl;
  }

  async render() {
    const pane = getElement('olx-saved-pane');
    if (!pane) return;

    pane.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:16px 0;">Učitavanje…</div>';

    let saves = [];
    try { saves = await this._db.getSavedSearches(); } catch {}

    // Sort: most recently scraped first, unscrapped saves last
    saves.sort((a, b) => (b.lastScrapedAt || 0) - (a.lastScrapedAt || 0));

    if (!saves.length) {
      pane.innerHTML = `
        <div class="olx-saved-empty">
          <div class="olx-saved-empty-icon">🔖</div>
          <div>Nema sačuvanih pretraga</div>
          <div class="olx-saved-empty-hint">
            Kliknite "💾 Sačuvaj" u gornjem dijelu panela da sačuvate trenutnu pretragu.<br>
            Sačuvane pretrage se automatski ažuriraju svakih 12 sati.
          </div>
        </div>`;
      return;
    }

    const isCurrentSaved = saves.some(s => s.searchKey === this._currentSearchKey);

    // Update save button state in the main panel toolbar
    const saveBtn = document.getElementById('olx-save-btn');
    if (saveBtn) {
      saveBtn.disabled = isCurrentSaved;
      saveBtn.title    = isCurrentSaved
        ? 'Ova pretraga je već sačuvana'
        : 'Sačuvaj ovu pretragu za automatsko praćenje';
    }

    // Listen for background rescrape completion to auto-refresh
    if (!this._rescrapeListener) {
      this._rescrapeListener = msg => {
        if (msg.type === 'SAVED_RESCRAPE_DONE') this.render();
      };
      browser.runtime.onMessage.addListener(this._rescrapeListener);
    }

    pane.innerHTML = `
      ${!isCurrentSaved ? `<div class="olx-saved-save-hint">
        <span style="font-size:12px;color:#6b7280;">Ova pretraga nije sačuvana.</span>
        <button id="olx-saved-inline-save" class="olx-saved-rescrape">💾 Sačuvaj ovu pretragu</button>
      </div>` : ''}
      <div id="olx-saved-list"></div>`;

    if (!isCurrentSaved) {
      pane.querySelector('#olx-saved-inline-save')?.addEventListener('click', () => {
        this._promptSave();
      });
    }

    const list = pane.querySelector('#olx-saved-list');
    for (const save of saves) {
      list.appendChild(this._buildCard(save));
    }
  }

  _buildCard(save) {
    const card = document.createElement('div');
    card.className = 'olx-saved-card';

    const savedAt    = save.savedAt    ? new Date(save.savedAt).toLocaleDateString('bs-BA')    : '—';
    const lastScrape = save.lastScrapedAt
      ? formatRelativeTime(Date.now() - save.lastScrapedAt) + ' nazad'
      : 'Još nije skenirano';

    const medianBadge = save.median
      ? `<span style="font-weight:600;color:#002f34;">${formatNumber(save.median)} KM/m²</span><span class="olx-saved-sep">·</span>`
      : '';
    const countBadge = save.listingCount != null
      ? `<span>${formatNumber(save.listingCount)} oglasa</span><span class="olx-saved-sep">·</span>`
      : '';
    const newBadge = save.newCount > 0
      ? `<span style="color:#10b981;font-weight:600;">+${save.newCount} novo</span><span class="olx-saved-sep">·</span>`
      : '';
    const dropBadge = save.dropCount > 0
      ? `<span style="color:#f59e0b;font-weight:600;">↓${save.dropCount} pad</span><span class="olx-saved-sep">·</span>`
      : '';

    const isCurrent = save.searchKey === this._currentSearchKey;

    card.innerHTML = `
      <div class="olx-saved-card-header">
        <div class="olx-saved-name" title="${escapeHtml(save.name)}">
          ${isCurrent ? '<span style="font-size:10px;background:#002f34;color:#fff;border-radius:4px;padding:1px 5px;margin-right:4px;">Aktivna</span>' : ''}
          ${escapeHtml(save.name)}
        </div>
        <div class="olx-saved-actions">
          <button class="olx-saved-rescrape" data-key="${escapeHtml(save.searchKey)}" title="Ažuriraj sada">↻ Ažuriraj</button>
          <button class="olx-saved-delete"   data-key="${escapeHtml(save.searchKey)}" title="Ukloni">✕</button>
        </div>
      </div>
      <div class="olx-saved-meta">
        ${medianBadge}${countBadge}${newBadge}${dropBadge}
        <span>Sačuvano: ${savedAt}</span>
        <span class="olx-saved-sep">·</span>
        <span>Ažurirano: ${lastScrape}</span>
      </div>
      <div class="olx-saved-url" title="${escapeHtml(save.url)}">${escapeHtml(save.url)}</div>
      ${!isCurrent ? `<a class="olx-saved-open" href="${escapeHtml(save.url)}" target="_blank">↗ Otvori pretragu</a>` : ''}`;

    card.querySelector('.olx-saved-delete').addEventListener('click', async () => {
      try { await this._db.deleteSavedSearch(save.searchKey); } catch {}
      await this.render();
    });

    const rescrapeBtn = card.querySelector('.olx-saved-rescrape');
    rescrapeBtn.addEventListener('click', () => {
      rescrapeBtn.textContent = '⏳ Skeniranje…';
      rescrapeBtn.disabled = true;
      browser.runtime.sendMessage({ type: 'RESCRAPE_SAVED', searchKey: save.searchKey }).catch(() => {});
      // Background will send SAVED_RESCRAPE_DONE when finished; listener in render()
    });

    return card;
  }

  async promptAndSave() {
    await this._promptSave();
  }

  async _promptSave() {
    // Simple inline name input — avoids a cross-origin prompt() call
    const existing = getElement('olx-save-name-bar');
    if (existing) { existing.remove(); return; }

    const bar = document.createElement('div');
    bar.id    = 'olx-save-name-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 18px;background:#f9fafb;border-top:1px solid #f0f0f0;flex-shrink:0;';
    bar.innerHTML = `
      <input id="olx-save-name-input" type="text" placeholder="Naziv pretrage…"
             style="flex:1;padding:6px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;outline:none;">
      <button id="olx-save-name-confirm"
              style="padding:6px 14px;background:#002f34;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;">Sačuvaj</button>
      <button id="olx-save-name-cancel"
              style="padding:6px 10px;background:#f3f4f6;color:#374151;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;">Otkaži</button>`;

    // Insert before the tab panes (right after the tab bar)
    const tabBar = getElement('olx-tab-bar');
    tabBar.insertAdjacentElement('afterend', bar);

    const input  = bar.querySelector('#olx-save-name-input');
    const cancel = bar.querySelector('#olx-save-name-cancel');
    const confirm = bar.querySelector('#olx-save-name-confirm');

    input.focus();

    cancel.addEventListener('click', () => bar.remove());

    const doSave = async () => {
      const name = input.value.trim() || 'Pretraga';
      bar.remove();
      try {
        await this._db.addSavedSearch(name, this._currentUrl, this._currentSearchKey);
      } catch {}
      // Switch to the Saved tab to confirm
      getElement('olx-tab-saved')?.click();
    };

    confirm.addEventListener('click', doSave);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSave();
      if (e.key === 'Escape') bar.remove();
    });
  }
}
