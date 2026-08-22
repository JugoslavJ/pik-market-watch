// OLX.ba Price per m² — Model: listings database (IndexedDB wrapper)

class ListingsDatabase {
  static get DB_NAME()          { return 'olx_listings_db'; }
  static get DB_VERSION()       { return 3; }            // must match background.js
  static get STORE_LISTINGS()   { return 'listings'; }
  static get STORE_SEARCHES()   { return 'searches'; }
  static get STORE_SAVED()      { return 'saved_searches'; }
  static get CACHE_TTL_MS()     { return 24 * 60 * 60 * 1000; }

  constructor() {
    this._db    = null;
    this._ready = null;   // Promise<this> resolved when DB is open
  }

  open() {
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      const req = indexedDB.open(ListingsDatabase.DB_NAME, ListingsDatabase.DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(ListingsDatabase.STORE_LISTINGS))
          db.createObjectStore(ListingsDatabase.STORE_LISTINGS, { keyPath: 'articleId' });
        if (!db.objectStoreNames.contains(ListingsDatabase.STORE_SEARCHES))
          db.createObjectStore(ListingsDatabase.STORE_SEARCHES, { keyPath: 'searchKey' });
        if (!db.objectStoreNames.contains(ListingsDatabase.STORE_SAVED))
          db.createObjectStore(ListingsDatabase.STORE_SAVED, { keyPath: 'searchKey' });
        // v3 intentionally does NOT create an isRent index — boolean values
        // are not valid IDB key types so the index would be empty. Rent filtering
        // is done in JS inside getRentListings().
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(this); };
      req.onerror   = () => reject(req.error);
    });
    return this._ready;
  }

  getCachedSearch(searchKey, { ignoreExpiry = false } = {}) {
    return this._get(ListingsDatabase.STORE_SEARCHES, searchKey).then(rec => {
      if (!rec) return null;
      if (!ignoreExpiry && Date.now() - rec.scrapedAt > ListingsDatabase.CACHE_TTL_MS) return null;
      return rec;
    });
  }

  saveSearchCache(searchKey, results) {
    return this._put(ListingsDatabase.STORE_SEARCHES, { searchKey, scrapedAt: Date.now(), results });
  }

  getAllListings() {
    return new Promise((resolve, reject) => {
      if (!this._db) return resolve([]);
      const req = this._db
        .transaction(ListingsDatabase.STORE_LISTINGS, 'readonly')
        .objectStore(ListingsDatabase.STORE_LISTINGS)
        .getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  /**
   * Fetch only rent listings, optionally excluding stale ones (lastSeen older than maxAgeDays).
   * Uses a simple JS filter over getAllListings — no IDB index needed.
   * Stale filtering prevents old rent data from suppressing estimates in a rising market.
   */
  getRentListings(maxAgeDays = 90) {
    const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;
    return this.getAllListings().then(all =>
      all.filter(r => r.isRent && r.price > 0 && (!cutoff || (r.lastSeen || 0) >= cutoff))
    );
  }

  /**
   * Upsert all cards in a single read-write transaction for atomicity and speed.
   * Previously used Promise.all(cards.map(upsertListing)) which opened N parallel
   * transactions and was unreliable with large result sets.
   */
  upsertAllListings(cards) {
    return new Promise((resolve, reject) => {
      if (!this._db || !cards.length) return resolve(new Map());

      const tx    = this._db.transaction(ListingsDatabase.STORE_LISTINGS, 'readwrite');
      const store = tx.objectStore(ListingsDatabase.STORE_LISTINGS);
      const now   = Date.now();
      const annotations = new Map();

      // Process cards sequentially within a single transaction using cursor-based reads
      let i = 0;
      const processNext = () => {
        if (i >= cards.length) return; // tx.oncomplete will fire
        const card      = cards[i++];
        const articleId = extractArticleId(card.url);
        if (!articleId) { processNext(); return; }

        const getReq = store.get(articleId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            const prevHistory  = Array.from(existing.priceHistory || []);
            const last         = prevHistory[prevHistory.length - 1];
            const priceChanged = last.ppm2 !== card.ppm2 || last.price !== card.price;
            let priceDrop = false, dropPct = null;
            // Build new history array — never mutate the IDB result array (XrayWrapper)
            const newHistory = priceChanged && card.ppm2 != null
              ? [...prevHistory, { scrapedAt: now, price: card.price, ppm2: card.ppm2 }]
              : prevHistory;
            if (priceChanged && card.ppm2 != null && last.ppm2 != null && card.ppm2 < last.ppm2) {
              priceDrop = true;
              dropPct   = Math.round((1 - card.ppm2 / last.ppm2) * 100);
            }
            // Build a brand-new plain object — never use Object.assign on IDB result (XrayWrapper)
            store.put(ListingsDatabase._buildRecord(articleId, card, now, existing.firstSeen, newHistory));
            annotations.set(articleId, { articleId, isNew: false, priceDrop, dropPct });
          } else {
            const initHistory = [{ scrapedAt: now, price: card.price, ppm2: card.ppm2 }];
            store.put(ListingsDatabase._buildRecord(articleId, card, now, now, initHistory));
            annotations.set(articleId, { articleId, isNew: true, priceDrop: false, dropPct: null });
          }
          processNext();
        };
        getReq.onerror = () => { processNext(); }; // skip on read error
      };

      tx.oncomplete = () => resolve(annotations);
      tx.onerror    = () => reject(tx.error);
      processNext();
    });
  }

  getListing(articleId) {
    return this._get(ListingsDatabase.STORE_LISTINGS, articleId);
  }

  // ── Saved searches ────────────────────────────────────────────────────────

  getSavedSearches() {
    return new Promise((resolve, reject) => {
      if (!this._db) return resolve([]);
      const req = this._db
        .transaction(ListingsDatabase.STORE_SAVED, 'readonly')
        .objectStore(ListingsDatabase.STORE_SAVED)
        .getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  addSavedSearch(name, url, searchKey) {
    return this._put(ListingsDatabase.STORE_SAVED, { searchKey, name, url, savedAt: Date.now() });
  }

  deleteSavedSearch(searchKey) {
    return new Promise((resolve, reject) => {
      if (!this._db) return resolve();
      const tx = this._db.transaction(ListingsDatabase.STORE_SAVED, 'readwrite');
      tx.objectStore(ListingsDatabase.STORE_SAVED).delete(searchKey);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── Batch read for sparklines/days — avoids N parallel transactions ──────

  /**
   * Stamp each of the given articleIds with soldAt = now (if not already sold).
   * The field is added to the existing record in-place — no schema change needed.
   */
  markListingsSold(articleIds) {
    return new Promise((resolve, reject) => {
      if (!this._db || !articleIds.length) return resolve();
      const now   = Date.now();
      const tx    = this._db.transaction(ListingsDatabase.STORE_LISTINGS, 'readwrite');
      const store = tx.objectStore(ListingsDatabase.STORE_LISTINGS);
      let pending = articleIds.length;
      const done  = () => { if (--pending === 0) { /* tx.oncomplete fires */ } };
      for (const id of articleIds) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result && !req.result.soldAt) {
            store.put({ ...req.result, soldAt: now });
          }
          done();
        };
        req.onerror = () => done();
      }
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  /**
   * Fetch sold (soldAt set) non-rent listings whose URL matches a simple prefix.
   * Used to show recently-sold listings as price anchors alongside live results.
   * @param {string} urlPrefix  — e.g. "https://www.olx.ba/nekretnine/stanovi-prodaja/"
   * @param {number} maxAgeDays — how far back to look (default 90 days)
   */
  getSoldSalesListings(urlPrefix, maxAgeDays = 90) {
    const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : 0;
    return this.getAllListings().then(all =>
      all.filter(r =>
        r.soldAt &&
        !r.isRent &&
        r.url && r.url.startsWith(urlPrefix) &&
        (!cutoff || r.soldAt >= cutoff)
      )
    );
  }

  getListingsBatch(articleIds) {
    return new Promise((resolve, reject) => {
      if (!this._db || !articleIds.length) return resolve(new Map());
      const tx    = this._db.transaction(ListingsDatabase.STORE_LISTINGS, 'readonly');
      const store = tx.objectStore(ListingsDatabase.STORE_LISTINGS);
      const map   = new Map();
      let pending = articleIds.length;
      for (const id of articleIds) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) map.set(id, req.result);
          if (--pending === 0) resolve(map);
        };
        req.onerror = () => { if (--pending === 0) resolve(map); };
      }
    });
  }

  _get(store, key) {
    return new Promise((resolve, reject) => {
      if (!this._db) return resolve(null);
      const req = this._db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  _put(store, record) {
    return new Promise((resolve, reject) => {
      if (!this._db) return reject(new Error('DB not open'));
      const tx = this._db.transaction(store, 'readwrite');
      tx.objectStore(store).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  /**
   * Build a plain listing record suitable for IDB storage.
   * Always constructs a brand-new object — never mutates an existing IDB result
   * (XrayWrapper restriction in Firefox content scripts).
   *
   * @param {string}   articleId
   * @param {object}   card         — parsed card data
   * @param {number}   now          — current timestamp (ms)
   * @param {number}   firstSeen    — original first-seen timestamp (ms)
   * @param {Array}    priceHistory — history array to store
   */
  static _buildRecord(articleId, card, now, firstSeen, priceHistory) {
    return {
      articleId,
      firstSeen,
      title:        card.title,
      url:          card.url,
      sqm:          card.sqm,
      rooms:        card.rooms,
      price:        card.price,
      priceText:    card.priceText,
      ppm2:         card.ppm2,
      isRent:       card.isRent,
      lastSeen:     now,
      priceHistory,
    };
  }
}
