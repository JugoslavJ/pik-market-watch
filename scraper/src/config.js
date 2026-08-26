"use strict";
// Configuration: environment variables + the searches list.
// Precedence for searches: SEARCH_URLS env → /config/searches.json.
// (No in-image fallback on purpose: with neither source present the scraper
// idles loudly instead of silently scraping whatever the example file holds.)

const fs = require("fs");
const path = require("path");

const SEARCHES_FILE = process.env.SEARCHES_FILE || "/config/searches.json";

// Where db/init migrations live: container mount first, repo checkout second.
const MIGRATIONS_DIR =
  [
    process.env.MIGRATIONS_DIR,
    "/db/init",
    path.join(__dirname, "..", "..", "db", "init"),
  ].find((d) => d && fs.existsSync(d)) || null;

function num(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Same URL minus page/hash/scrape params → stable primary key per search.
function normalizeSearchKey(href) {
  const u = new URL(href);
  u.searchParams.delete("page");
  u.searchParams.delete("olx_scrape");
  u.hash = "";
  return u.pathname + u.search;
}

function loadSearches() {
  // 1) SEARCH_URLS="https://...,https://..." env override
  const envUrls = (process.env.SEARCH_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envUrls.length) return envUrls.map((url) => ({ url }));

  // 2) mounted JSON file
  try {
    const parsed = JSON.parse(fs.readFileSync(SEARCHES_FILE, "utf8"));
    const arr = Array.isArray(parsed) ? parsed : parsed.searches;
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (_) {
    /* missing or invalid */
  }
  return [];
}

// Identical URLs normalize onto one search_key; keep the first occurrence so a
// copy-pasted duplicate doesn't scrape the same search twice per cycle
// (double rate-limit spend for zero new data, doubled run stats).
function dedupeBySearchKey(searches) {
  const seen = new Set();
  return searches.filter(
    ({ searchKey }) => !seen.has(searchKey) && seen.add(searchKey),
  );
}

module.exports = {
  // Lazy on purpose: requiring this module must NEVER throw (the unit tests
  // load it without env), but running without DATABASE_URL must fail fast
  // with a clear message instead of silently trying the old weak olx:olx
  // fallback credentials.
  get databaseUrl() {
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        "DATABASE_URL is not set — compose injects it from .env " +
          "(POSTGRES_APP_USER/PASSWORD); export it for bare-metal runs.",
      );
    return url;
  },
  migrationsDir: MIGRATIONS_DIR, // db/init/*.sql applied on startup
  normalizeSearchKey, // stable per-search primary key
  intervalMinutes: num(process.env.SCRAPE_INTERVAL_MINUTES, 720),
  runOnce: process.env.RUN_ONCE === "1" || process.argv.includes("--once"),
  maxPages: num(process.env.MAX_PAGES, 30), // pagination cap (pages of `perPage`)
  concurrency: num(process.env.CONCURRENCY, 3), // search pages fetched in parallel
  pageDelayMs: num(process.env.PAGE_DELAY_MS, 1500), // politeness gap between waves
  perPage: num(process.env.API_PER_PAGE, 40), // olx.ba UI default
  apiTimeoutMs: num(process.env.API_TIMEOUT_MS, 20000), // per-request HTTP timeout
  healthPort: num(process.env.HEALTH_PORT, 9100),
  maxGeoFetches: num(process.env.MAX_GEO_FETCHES, 25), // /api/listings detail calls per run
  geoConcurrency: num(process.env.GEO_CONCURRENCY, 2), // parallel detail calls
  geoDelayMs: num(process.env.GEO_DELAY_MS, 1200), // politeness gap between batches
  minRunGapMinutes: num(process.env.SCRAPE_MIN_GAP_MINUTES, 45), // skip boot cycle if a run finished this recently
  healthFailureThreshold: num(process.env.HEALTH_FAILURE_THRESHOLD, 3), // fully-failed cycles in a row before /health answers 503

  searches: dedupeBySearchKey(
    loadSearches().map((s) => {
      let name = s.name;
      if (!name) {
        try {
          name = decodeURIComponent(
            new URL(s.url).pathname.replace(/\/+$/, "").split("/").pop(),
          );
        } catch (_) {
          name = s.url;
        }
      }
      return {
        url: s.url,
        name: name || s.url,
        category: (s.category || "").trim() || null, // free-form label used by dashboards
        searchKey: normalizeSearchKey(s.url),
      };
    }),
  ),
};
