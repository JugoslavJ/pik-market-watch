// Background script for OLX.ba Price per m²
// Manages hidden scraper tabs, routes card data back to source tabs,
// and auto-rescrapes saved searches on a periodic alarm.

const ALARM_NAME   = 'olx-auto-rescrape';
const ALARM_PERIOD = 12 * 60; // minutes

// ── Keyboard command ──────────────────────────────────────────────────────────

browser.commands.onCommand.addListener(cmd => {
  if (cmd !== 'toggle-panel') return;
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_PANEL' }).catch(() => {});
  });
});

// ── Tab routing (interactive scrape, page-by-page) ────────────────────────────

const pendingScraperTabs = {};

function reportFailedPage(sourceTabId, pageNumber, scraperTabId) {
  if (sourceTabId != null)
    browser.tabs.sendMessage(sourceTabId, { type: 'PAGE_SCRAPED', page: pageNumber, cards: [] }).catch(() => {});
  if (scraperTabId != null)
    browser.tabs.remove(scraperTabId).catch(() => {});
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

const DB_NAME     = 'olx_listings_db';
const DB_VERSION  = 3;   // must match listings-db.js
const ST_SAVED    = 'saved_searches';
const ST_SEARCH   = 'searches';
const ST_LISTINGS = 'listings';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(ST_LISTINGS))
        db.createObjectStore(ST_LISTINGS, { keyPath: 'articleId' });
      if (!db.objectStoreNames.contains(ST_SEARCH))
        db.createObjectStore(ST_SEARCH,   { keyPath: 'searchKey' });
      if (!db.objectStoreNames.contains(ST_SAVED))
        db.createObjectStore(ST_SAVED,    { keyPath: 'searchKey' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

function dbPut(db, store, record) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── Alarm registration ────────────────────────────────────────────────────────

browser.alarms.get(ALARM_NAME).then(existing => {
  if (!existing) {
    browser.alarms.create(ALARM_NAME, {
      delayInMinutes:  ALARM_PERIOD,
      periodInMinutes: ALARM_PERIOD,
    });
  }
});

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  try { await runAutoRescrape(); }
  catch (err) { console.warn('[OLX ext] Auto-rescrape failed:', err); }
});

// ── Auto-rescrape ─────────────────────────────────────────────────────────────

async function runAutoRescrape() {
  const db    = await openDB();
  const saves = await dbGetAll(db, ST_SAVED);
  if (saves.length === 0) return;
  console.log(`[OLX ext] Auto-rescraping ${saves.length} saved search(es)`);
  for (const save of saves) {
    try { await rescrapeOne(db, save); }
    catch (err) { console.warn(`[OLX ext] Rescrape failed for "${save.name}":`, err); }
  }
  // Tell open OLX tabs to refresh their trigger badge
  const tabs = await browser.tabs.query({ url: '*://*.olx.ba/*' }).catch(() => []);
  for (const tab of tabs)
    browser.tabs.sendMessage(tab.id, { type: 'REFRESH_BADGE' }).catch(() => {});
}

async function rescrapeOne(db, save) {
  const baseUrl = new URL(save.url);
  baseUrl.searchParams.delete('page');
  baseUrl.searchParams.delete('olx_scrape');
  baseUrl.searchParams.delete('olx_open_scraper');
  baseUrl.hash = '';

  // Build page-1 URL properly via searchParams (avoids manual ?/& splicing)
  const page1url = new URL(baseUrl.href);
  page1url.searchParams.set('olx_scrape', 'true');

  const page1cards = await scrapeHiddenTab(page1url.href);
  if (!page1cards) return;

  let allCards = [...page1cards];

  // Estimate max pages from previous cache, cap at 30
  const cached  = await dbGet(db, ST_SEARCH, save.searchKey).catch(() => null);
  const maxPage = cached ? Math.min(30, Math.ceil((cached.results?.length || 40) / 40)) : 1;

  if (maxPage > 1) {
    const pages = Array.from({ length: maxPage - 1 }, (_, i) => i + 2);
    for (let i = 0; i < pages.length; i += 5) {
      const batch = pages.slice(i, i + 5);
      const batchCards = await Promise.all(batch.map(p => {
        const u = new URL(baseUrl.href);
        u.searchParams.set('page', p);
        u.searchParams.set('olx_scrape', 'true');
        return scrapeHiddenTab(u.href).then(c => c || []).catch(() => []);
      }));
      for (const cards of batchCards) allCards.push(...cards);
    }
  }

  const seen = new Set();
  allCards = allCards.filter(c => { if (seen.has(c.url)) return false; seen.add(c.url); return true; });

  // Upsert all cards in a single IDB transaction (avoids N sequential transactions)
  const { newCount, dropCount } = await upsertAllListings(db, allCards);

  // Compute median ppm2 — mirrors computeMedian() in shared/utils.js (different context)
  const ppm2 = allCards.map(c => c.ppm2).filter(Boolean).sort((a, b) => a - b);
  const n    = ppm2.length;
  const median = n === 0 ? null :
    n % 2 ? ppm2[n >> 1] : Math.round((ppm2[(n >> 1) - 1] + ppm2[n >> 1]) / 2);

  await dbPut(db, ST_SEARCH, { searchKey: save.searchKey, scrapedAt: Date.now(), results: allCards }).catch(() => {});
  await dbPut(db, ST_SAVED, {
    ...save,
    lastScrapedAt: Date.now(),
    listingCount:  allCards.length,
    median,
    newCount,
    dropCount,
  });
}

/**
 * Scrape a URL in a hidden tab and return its cards.
 *
 * Bug fix: the previous version never resolved the Promise on success because
 * it relied on pendingScraperTabs which only routes messages from the interactive
 * scraper, not from rescrapeOne. This version registers a one-shot CARDS_READY
 * listener keyed to the specific tab ID, so it resolves as soon as the tab sends
 * its results rather than always waiting 30 seconds.
 */
function scrapeHiddenTab(url) {
  return new Promise(resolve => {
    browser.tabs.create({ url, active: false })
      .then(tab => {
        let resolved = false;
        const finish = cards => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          browser.runtime.onMessage.removeListener(listener);
          browser.tabs.remove(tab.id).catch(() => {});
          resolve(cards);
        };

        // Listen for CARDS_READY specifically from this tab
        const listener = (message, sender) => {
          if (sender.tab?.id === tab.id && message.type === 'CARDS_READY') {
            finish(message.cards);
          }
        };
        browser.runtime.onMessage.addListener(listener);

        const timeout = setTimeout(() => finish(null), 30_000);
      })
      .catch(() => resolve(null));
  });
}

/**
 * Upsert all cards in a single IDB transaction.
 * Returns { newCount, dropCount }.
 */
/**
 * Build a plain listing record for IDB storage.
 * Must be a brand-new object — never mutate an existing IDB result (XrayWrapper).
 * NOTE: This mirrors ListingsDatabase._buildRecord in model/listings-db.js.
 * Background scripts run in a separate context and cannot share source files
 * with content scripts, so this is an intentional parallel implementation.
 */
function buildListingRecord(articleId, card, now, firstSeen, priceHistory) {
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

function upsertAllListings(db, cards) {
  return new Promise((resolve, reject) => {
    if (!cards.length) return resolve({ newCount: 0, dropCount: 0 });

    const tx    = db.transaction(ST_LISTINGS, 'readwrite');
    const store = tx.objectStore(ST_LISTINGS);
    const now   = Date.now();
    let newCount = 0, dropCount = 0;

    let i = 0;
    const processNext = () => {
      if (i >= cards.length) return; // tx.oncomplete fires when all puts are done
      const card      = cards[i++];
      const articleId = extractArticleId(card.url);
      if (!articleId) { processNext(); return; }

      const getReq = store.get(articleId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          const prevHistory  = Array.from(existing.priceHistory || []);
          const last         = prevHistory[prevHistory.length - 1];
          const priceChanged = (last.ppm2 !== card.ppm2 || last.price !== card.price) && card.ppm2 != null;
          const newHistory   = priceChanged
            ? [...prevHistory, { scrapedAt: now, price: card.price, ppm2: card.ppm2 }]
            : prevHistory;
          if (priceChanged && last.ppm2 != null && card.ppm2 < last.ppm2) dropCount++;
          store.put(buildListingRecord(articleId, card, now, existing.firstSeen, newHistory));
        } else {
          const initHistory = [{ scrapedAt: now, price: card.price, ppm2: card.ppm2 }];
          store.put(buildListingRecord(articleId, card, now, now, initHistory));
          newCount++;
        }
        processNext();
      };
      getReq.onerror = () => processNext();
    };

    tx.oncomplete = () => resolve({ newCount, dropCount });
    tx.onerror    = () => reject(tx.error);
    processNext();
  });
}

// ── Message router ────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender) => {
  const senderTabId = sender.tab?.id;

  if (message.type === 'CARDS_READY') {
    const entry = pendingScraperTabs[senderTabId];
    if (entry) {
      delete pendingScraperTabs[senderTabId];
      clearTimeout(entry.timeoutHandle);
      browser.tabs.sendMessage(entry.sourceTabId, {
        type:  'PAGE_SCRAPED',
        page:  entry.pageNumber,
        cards: message.cards,
      }).catch(() => {});
      browser.tabs.remove(senderTabId).catch(() => {});
    }
    return;
  }

  if (message.type === 'OPEN_TABS') {
    const urls = Array.isArray(message.urls) ? message.urls.slice(0, 10) : [];
    for (const url of urls)
      browser.tabs.create({ url, active: false }).catch(() => {});
    return;
  }

  if (message.type === 'RESCRAPE_SAVED') {
    // Manual rescrape triggered from the Saved tab UI
    openDB().then(async db => {
      const save = await dbGet(db, ST_SAVED, message.searchKey).catch(() => null);
      if (!save) return;
      try {
        await rescrapeOne(db, save);
      } catch (err) {
        console.warn('[OLX ext] Manual rescrape failed:', err);
      } finally {
        browser.tabs.sendMessage(senderTabId, {
          type: 'SAVED_RESCRAPE_DONE', searchKey: message.searchKey,
        }).catch(() => {});
      }
    }).catch(() => {});
    return;
  }

  if (message.type === 'SCRAPE_URL') {
    browser.tabs.create({ url: message.url, active: false })
      .then(newTab => {
        pendingScraperTabs[newTab.id] = {
          sourceTabId:   senderTabId,
          pageNumber:    message.page,
          timeoutHandle: setTimeout(() => {
            if (!pendingScraperTabs[newTab.id]) return;
            delete pendingScraperTabs[newTab.id];
            reportFailedPage(senderTabId, message.page, newTab.id);
          }, 30_000),
        };
      })
      .catch(() => reportFailedPage(senderTabId, message.page, null));
    return true;
  }
});
// ── Shared with content script — must match shared/utils.js ──────────────────
// Uses the same /artikal/(\d+) pattern as the content script's extractArticleId.

function extractArticleId(url) {
  const m = url.match(/\/artikal\/(\d+)/i);
  return m ? m[1] : null;
}
