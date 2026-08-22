// OLX.ba Price per m² — Controller: orchestrates scraping, caching, and rendering

class ScraperController {
  /**
   * @param {ListingsDatabase} db
   * @param {UserConfig}       config
   * @param {object}           views   { progress, summary, table, charts, configTab }
   */
  constructor(db, config, views) {
    this._db        = db;
    this._config    = config;
    this._searchKey = buildSearchCacheKey(location.href);
    this._views     = views;
    this._scraper   = new PageScraper({
      onProgress: (pct, txt) => views.progress.setProgress(pct, txt),
      onCard:     ()          => views.table.render(this._scraper.results),
      onFinish:   ()          => this._onScrapeFinished(),
    });
  }

  get searchKey() { return this._searchKey; }

  /** Public access to the current scraper results (used by CSV export). */
  get results() { return this._scraper.results; }

  /** Load cached results on startup. */
  async loadCache() {
    if (!this._db) return;

    // Wait for IDB to finish opening (including any upgrade transaction).
    // If IDB is completely unavailable (e.g. private browsing), show a banner
    // rather than leaving the panel silently blank.
    try {
      await this._db.open();
    } catch {
      this._showCacheBanner('stale', '<span>⚠ Keš nije dostupan (privatno pretraživanje?). Podaci neće biti sačuvani.</span>');
      return;
    }

    const rentStats = await this._calcRentStats();
    this._views.table.setRentStats(rentStats);
    this._views.configTab.setRentStats(rentStats);

    let cached = await this._db.getCachedSearch(this._searchKey);
    const stale = !cached;
    if (stale) cached = await this._db.getCachedSearch(this._searchKey, { ignoreExpiry: true });
    if (!cached) return;

    const ageLabel = formatRelativeTime(Date.now() - cached.scrapedAt);
    this._renderResults(cached.results);

    const rescrapeBtn = `<button id="olx-cache-rescrape-btn">Skeniraj ponovo</button>`;
    if (stale) {
      this._showCacheBanner('stale', `<span>Podaci stari ${ageLabel} \u2014 preporuka: pokrenite novo skeniranje.</span>${rescrapeBtn}`);
    } else {
      this._showCacheBanner('fresh', `<span>\u2713 Ke\u0161irani rezultati (stari ${ageLabel}).</span>${rescrapeBtn}`);
    }
    getElement('olx-cache-rescrape-btn').onclick = () => this.startScrape();
    getElement('olx-export-btn').disabled = cached.results.length === 0;
  }

  /** Begin a fresh scrape. */
  startScrape() {
    getElement('olx-scrape-btn').innerHTML = '\u23F9 Zaustavi';
    getElement('olx-scrape-btn').onclick   = () => this._scraper.abort();
    getElement('olx-export-btn').disabled  = true;
    this._views.progress.show();
    this._views.summary.hide();
    this._views.table.clear();
    hideEl('olx-meta-bar');
    hideEl('olx-cache-banner');
    this._scraper.start();
  }

  onConfigChange() {
    this._views.table.setConfig(this._config);
  }

  // ── Private ───────────────────────────────────────────────────────────

  async _onScrapeFinished() {
    const results = this._scraper.results;
    const total   = this._scraper.total;

    const finishUI = () => {
      getElement('olx-scrape-btn').innerHTML = `${Icons.search(13)} Skeniraj`;
      getElement('olx-scrape-btn').disabled  = false;
      getElement('olx-scrape-btn').onclick   = () => this.startScrape();
      getElement('olx-export-btn').disabled  = results.length === 0;
      this._views.progress.setProgress(
        100,
        `Gotovo! ${SerbianDeclension.declareListing(results.length)} na ${SerbianDeclension.declinePage(total)}.`
      );
    };

    if (this._db) {
      this._db.saveSearchCache(this._searchKey, results).catch(() => {});
      this._db.upsertAllListings(results).then(async annotationMap => {
        for (const r of results) {
          const id  = extractArticleId(r.url);
          const ann = id ? annotationMap.get(id) : null;
          r.isNew     = ann?.isNew     ?? false;
          r.priceDrop = ann?.priceDrop ?? false;
          r.dropPct   = ann?.dropPct   ?? null;
        }

        // Mark listings that were previously seen but are absent from the
        // current scrape as sold/removed.
        try {
          const liveIds    = new Set(results.map(r => extractArticleId(r.url)).filter(Boolean));
          const urlPrefix  = new URL(location.href).origin + new URL(location.href).pathname.split('/').slice(0, 3).join('/') + '/';
          const soldIds    = [...annotationMap.keys()].filter(id => !liveIds.has(id));
          if (soldIds.length) await this._db.markListingsSold(soldIds);
          const soldRecs   = await this._db.getSoldSalesListings(urlPrefix);
          this._views.table.setSoldListings(soldRecs);
        } catch {}

        const rentStats2 = await this._calcRentStats();
        this._views.table.setRentStats(rentStats2);
        this._views.configTab.setRentStats(rentStats2);
        this._renderResults(results);
        finishUI();
      }).catch(() => {
        this._renderResults(results);
        finishUI();
      });
    } else {
      this._renderResults(results);
      finishUI();
    }
  }

  _renderResults(results) {
    const median = this._views.summary.render(results);
    this._views.table.setMedian(median);
    // When prefetch enriches results with days, re-render the summary strip
    // so medianDays appears without needing a full re-scrape.
    this._views.table.setOnDaysReady(enriched => {
      this._views.summary.render(enriched);
    });
    this._views.table.render(results);
    this._views.charts.update(results, median);
    if (median != null || results.some(r => r.isRent)) {
      showEl('olx-meta-bar');
    }
  }

  async _calcRentStats() {
    if (!this._db) return null;
    try {
      // Use the isRent index for O(rent listings) performance.
      // Exclude listings not seen in the last 90 days to avoid stale rents
      // depressing estimates in a rising market.
      const rentAds = await this._db.getRentListings(90);
      if (!rentAds.length) return null;

      const listings = rentAds.map(l => ({ rooms: l.rooms, sqm: l.sqm || 0, price: l.price }));

      const byRoom = {}, perSqm = [];
      for (const r of rentAds) {
        if (r.sqm) perSqm.push(r.price / r.sqm);
        if (r.rooms) {
          const k = normRooms(r.rooms);
          if (k != null) {
            if (!byRoom[k]) byRoom[k] = [];
            byRoom[k].push(r.price);
          }
        }
      }
      const medians = {};
      for (const k in byRoom) medians[k] = computeMedian(byRoom[k]);

      return { listings, byRoom: medians, medianSqm: computeMedian(perSqm) || 0 };
    } catch {
      return null;
    }
  }

  /** Show the cache banner with a given state ('fresh' | 'stale') and inner HTML. */
  _showCacheBanner(state, innerHTML) {
    const banner = getElement('olx-cache-banner');
    if (!banner) return;
    banner.className = `olx-cache-banner olx-cache-${state}`;
    banner.innerHTML = innerHTML;
    showEl('olx-cache-banner');
  }
}
