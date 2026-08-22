// OLX.ba Price per m² — multi-page background scraper

class PageScraper {
  constructor({ onProgress, onCard, onFinish }) {
    this._onProgress = onProgress;
    this._onCard     = onCard;
    this._onFinish   = onFinish;
    this._results    = [];
    this._seen       = new Set();
    this._aborted    = false;
    this._pending    = 0;
    this._total      = 0;
    this._done       = 0;
    this._finished   = false;      // guard: _onFinish fires at most once
    this._waveListeners = [];      // tracked so abort() can clean them up

    // Store bound reference so we can removeListener on destroy()
    this._boundOnMessage = msg => this._onMessage(msg);
    browser.runtime.onMessage.addListener(this._boundOnMessage);
  }

  get results() { return this._results; }
  get total()   { return this._total; }

  /** Remove the permanent message listener. Call when the scraper is no longer needed. */
  destroy() {
    browser.runtime.onMessage.removeListener(this._boundOnMessage);
    this._cleanWaveListeners();
  }

  async start() {
    this._results  = []; this._seen = new Set();
    this._aborted  = false; this._pending = 0; this._total = 0;
    this._done     = 0; this._finished = false;

    this._onProgress(2, 'Učitavanje stranice…');
    const curPage = +(new URL(location.href).searchParams.get('page') || 1);
    this._addCards(CardParser.collectAllCards());

    this._onProgress(5, 'Otkrivanje stranica…');
    this._total = await this._waitForTotal();
    this._done  = 1;

    if (this._total <= 1) { this._finish(); return; }

    const others  = Array.from({ length: this._total }, (_, i) => i + 1).filter(p => p !== curPage);
    this._pending = others.length;
    this._onProgress(10, `Pokretanje ${SerbianDeclension.declinePage(others.length)}…`);
    this._dispatch(others);
  }

  abort() {
    this._aborted = true;
    this._pending = 0;
    this._cleanWaveListeners();
    this._finish();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _finish() {
    if (this._finished) return;   // guard: fire exactly once
    this._finished = true;
    this._onFinish();
  }

  _addCards(cards) {
    for (const c of cards) {
      const key = c.url || c.title;
      if (!this._seen.has(key)) { this._seen.add(key); this._results.push(c); }
    }
    this._onCard();
  }

  _onMessage(msg) {
    if (msg.type !== 'PAGE_SCRAPED') return;
    if (this._aborted) return;     // ignore late arrivals after abort
    this._pending--; this._done++;
    this._addCards(msg.cards);
    this._onProgress(
      Math.round((this._done / this._total) * 90) + 10,
      `${SerbianDeclension.declinePage(this._done)} od ${this._total} — ${SerbianDeclension.declareListing(this._results.length)}…`
    );
    if (this._pending <= 0) this._finish();
  }

  _totalPages() {
    let max = 1;
    for (const a of document.querySelectorAll('a[href*="page="]')) {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) max = Math.max(max, +m[1]);
    }
    if (max > 1) return max;
    const m = document.body.innerText.match(/(\d[\d.,]*)\s*REZULTATA/i);
    return m ? Math.ceil(parseNumber(m[1]) / PageScraper.PER_PAGE) : null;
  }

  _waitForTotal(ms = 8000) {
    return new Promise(resolve => {
      const v = this._totalPages();
      if (v) { resolve(v); return; }
      const t0 = Date.now();
      const iv = setInterval(() => {
        const v = this._totalPages();
        if (v)                    { clearInterval(iv); resolve(v); return; }
        if (Date.now() - t0 > ms) { clearInterval(iv); resolve(1); }
      }, 300);
    });
  }

  _pageUrl(p) {
    const u = new URL(location.href);
    u.searchParams.set('page', p);
    u.searchParams.set('olx_scrape', 'true');
    u.hash = '';
    return u.toString();
  }

  async _dispatch(pages) {
    for (let i = 0; i < pages.length; i += PageScraper.WAVE) {
      if (this._aborted) break;
      const wave = pages.slice(i, i + PageScraper.WAVE);
      for (const p of wave)
        browser.runtime.sendMessage({ type: 'SCRAPE_URL', url: this._pageUrl(p), page: p }).catch(() => {});
      if (i + PageScraper.WAVE < pages.length) await this._waitWave(wave.length);
    }
  }

  _waitWave(n) {
    return new Promise(resolve => {
      let rem = n;
      const fn = msg => {
        if (msg.type !== 'PAGE_SCRAPED') return;
        if (--rem <= 0) {
          this._removeWaveListener(fn);
          resolve();
        }
      };
      fn._resolve = resolve;   // stored so _cleanWaveListeners can unblock the awaiter
      this._waveListeners.push(fn);
      browser.runtime.onMessage.addListener(fn);
    });
  }

  _removeWaveListener(fn) {
    browser.runtime.onMessage.removeListener(fn);
    const idx = this._waveListeners.indexOf(fn);
    if (idx >= 0) this._waveListeners.splice(idx, 1);
  }

  _cleanWaveListeners() {
    for (const fn of this._waveListeners) {
      browser.runtime.onMessage.removeListener(fn);
      fn._resolve?.();   // unblock any pending await _waitWave() so _dispatch() can exit
    }
    this._waveListeners = [];
  }
}

PageScraper.PER_PAGE = 40;
PageScraper.WAVE     = 5;
