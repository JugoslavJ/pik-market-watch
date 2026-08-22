'use strict';
// Configuration: environment variables + the searches list.
// Precedence for searches: SEARCH_URLS env → /config/searches.json → bundled example.

const fs = require('fs');
const path = require('path');

const SEARCHES_FILE = process.env.SEARCHES_FILE || '/config/searches.json';
const FALLBACK_FILE = path.join(__dirname, '..', 'searches.example.json');

// Where db/init migrations live: container mount first, repo checkout second.
const MIGRATIONS_DIR =
  [process.env.MIGRATIONS_DIR, '/db/init', path.join(__dirname, '..', '..', 'db', 'init')]
    .find(d => d && fs.existsSync(d)) || null;

function num(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Same normalization as buildSearchCacheKey() in the original extension:
// same URL minus page/hash/scrape params → stable primary key per search.
function normalizeSearchKey(href) {
  const u = new URL(href);
  u.searchParams.delete('page');
  u.searchParams.delete('olx_scrape');
  u.hash = '';
  return u.pathname + u.search;
}

function loadSearches() {
  // 1) SEARCH_URLS="https://...,https://..." env override
  const envUrls = (process.env.SEARCH_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envUrls.length) return envUrls.map(url => ({ url }));

  // 2) mounted JSON file, 3) bundled example as a last resort
  for (const file of [SEARCHES_FILE, FALLBACK_FILE]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const arr = Array.isArray(parsed) ? parsed : parsed.searches;
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) { /* missing or invalid — try the next source */ }
  }
  return [];
}

module.exports = {
  databaseUrl:     process.env.DATABASE_URL || 'postgres://olx:olx@db:5432/olx',
  migrationsDir:   MIGRATIONS_DIR,                            // db/init/*.sql applied on startup
  intervalMinutes: num(process.env.SCRAPE_INTERVAL_MINUTES, 720),
  runOnce:         process.env.RUN_ONCE === '1' || process.argv.includes('--once'),
  maxPages:        num(process.env.MAX_PAGES, 30),           // extension cap was 30
  concurrency:     num(process.env.CONCURRENCY, 3),          // pages fetched in parallel
  pageDelayMs:     num(process.env.PAGE_DELAY_MS, 1500),     // politeness gap between waves
  navTimeoutMs:    num(process.env.NAV_TIMEOUT_MS, 45000),
  cardTimeoutMs:   num(process.env.CARD_TIMEOUT_MS, 25000),  // extension fallback was 25 s
  headless:        process.env.HEADLESS !== '0',
  healthPort:      num(process.env.HEALTH_PORT, 9100),
  maxGeoFetches:   num(process.env.MAX_GEO_FETCHES, 50),     // ad-detail visits per run for geo pins
  geoConcurrency:  num(process.env.GEO_CONCURRENCY, 2),      // parallel ad-detail fetches
  geoDelayMs:      num(process.env.GEO_DELAY_MS, 600),       // politeness gap between batches
  geoSettleMs:     num(process.env.GEO_SETTLE_MS, 2500),     // hydration wait on each ad page

  searches: loadSearches().map(s => {
    let name = s.name;
    if (!name) {
      try { name = decodeURIComponent(new URL(s.url).pathname.replace(/\/+$/, '').split('/').pop()); }
      catch (_) { name = s.url; }
    }
    return {
      url: s.url,
      name: name || s.url,
      category: (s.category || '').trim() || null,   // free-form label used by dashboards
      searchKey: normalizeSearchKey(s.url),
    };
  }),
};
