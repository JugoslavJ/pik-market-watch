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

function integer(
  name,
  v,
  def,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (v == null || String(v).trim() === "") return def;
  const raw = String(v).trim();
  if (!/^[0-9]+$/.test(raw))
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(v)}`,
    );
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(v)}`,
    );
  return n;
}

function boolean(name, v, def) {
  if (v == null || String(v).trim() === "") return def;
  const raw = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(
    `${name} must be a boolean (1/0, true/false, yes/no, or on/off); received ${JSON.stringify(v)}`,
  );
}

// Same URL minus page/hash/scrape params → stable primary key per search.
function normalizeSearchKey(href) {
  const u = new URL(href);
  u.searchParams.delete("page");
  u.searchParams.delete("olx_scrape");
  u.hash = "";
  // URL query order is not part of the search's meaning. Keep the API's
  // established filter order for readable keys, then sort all other names.
  const preferred = new Map([
    ["category_id", 0],
    ["canton", 1],
    ["cities", 2],
  ]);
  const params = [...u.searchParams.entries()].map((entry, index) => ({
    entry,
    index,
  }));
  params.sort(
    (a, b) =>
      (preferred.get(a.entry[0]) ?? 10) - (preferred.get(b.entry[0]) ?? 10) ||
      (a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : 0) ||
      a.index - b.index,
  );
  u.search = new URLSearchParams(params.map(({ entry }) => entry)).toString();
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
  let raw;
  try {
    raw = fs.readFileSync(SEARCHES_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        `cannot read SEARCHES_FILE ${SEARCHES_FILE}: ${error.message}`,
        { cause: error },
      );
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? parsed.searches
        : undefined;
    if (!Array.isArray(arr))
      throw new Error(
        `SEARCHES_FILE ${SEARCHES_FILE} must contain an array or a {"searches":[]} object`,
      );
    for (const [index, search] of arr.entries()) {
      if (
        !search ||
        typeof search !== "object" ||
        typeof search.url !== "string" ||
        !search.url.trim()
      )
        throw new Error(
          `SEARCHES_FILE ${SEARCHES_FILE} search at index ${index} must contain a non-empty url`,
        );
    }
    return arr;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(
        `SEARCHES_FILE ${SEARCHES_FILE} is not valid JSON: ${error.message}`,
        { cause: error },
      );
    throw error;
  }
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
  // Compose runs migrations in the dedicated migrator job before starting
  // the scraper. Bare-metal runs keep the fallback enabled unless explicitly
  // delegated to another deployment job.
  migrationsOnStartup: boolean(
    "MIGRATIONS_ON_STARTUP",
    process.env.MIGRATIONS_ON_STARTUP,
    true,
  ),
  migrationsDir: MIGRATIONS_DIR, // db/init/*.sql applied on startup
  normalizeSearchKey, // stable per-search primary key
  intervalMinutes: integer(
    "SCRAPE_INTERVAL_MINUTES",
    process.env.SCRAPE_INTERVAL_MINUTES,
    720,
    { min: 1 },
  ),
  runOnce: process.env.RUN_ONCE === "1" || process.argv.includes("--once"),
  maxPages: integer("MAX_PAGES", process.env.MAX_PAGES, 30, { min: 1 }), // pagination cap (pages of `perPage`)
  concurrency: integer("CONCURRENCY", process.env.CONCURRENCY, 3, { min: 1 }), // search pages fetched in parallel
  pageDelayMs: integer("PAGE_DELAY_MS", process.env.PAGE_DELAY_MS, 1500), // politeness gap between waves
  perPage: integer("API_PER_PAGE", process.env.API_PER_PAGE, 40, { min: 1 }), // olx.ba UI default
  apiTimeoutMs: integer("API_TIMEOUT_MS", process.env.API_TIMEOUT_MS, 20000, {
    min: 1,
  }), // per-request HTTP timeout
  healthPort: integer("HEALTH_PORT", process.env.HEALTH_PORT, 9100, {
    min: 1,
    max: 65535,
  }),
  healthBind: (process.env.HEALTH_BIND || "127.0.0.1").trim() || "127.0.0.1",
  maxGeoFetches: integer("MAX_GEO_FETCHES", process.env.MAX_GEO_FETCHES, 25), // /api/listings detail calls per run
  detailRefreshDays: integer(
    "DETAIL_REFRESH_DAYS",
    process.env.DETAIL_REFRESH_DAYS,
    7,
    { min: 1 },
  ),
  detailJobLeaseMinutes: integer(
    "DETAIL_JOB_LEASE_MINUTES",
    process.env.DETAIL_JOB_LEASE_MINUTES,
    30,
    { min: 1, max: 24 * 60 },
  ),
  rawResponseRetentionDays: integer(
    "RAW_RESPONSE_RETENTION_DAYS",
    process.env.RAW_RESPONSE_RETENTION_DAYS,
    30,
    { min: 1 },
  ),
  analyticsRebuildMaxDays: integer(
    "ANALYTICS_REBUILD_MAX_DAYS",
    process.env.ANALYTICS_REBUILD_MAX_DAYS,
    31,
    { min: 1, max: 366 },
  ),
  geoConcurrency: integer("GEO_CONCURRENCY", process.env.GEO_CONCURRENCY, 2, {
    min: 1,
  }), // parallel detail calls
  geoDelayMs: integer("GEO_DELAY_MS", process.env.GEO_DELAY_MS, 1200), // politeness gap between batches
  rateLimitCooldownMs: integer(
    "RATE_LIMIT_COOLDOWN_MS",
    process.env.RATE_LIMIT_COOLDOWN_MS,
    65000,
    { min: 0, max: 24 * 60 * 60 * 1000 },
  ), // fallback when the API omits a reset timestamp
  minRunGapMinutes: integer(
    "SCRAPE_MIN_GAP_MINUTES",
    process.env.SCRAPE_MIN_GAP_MINUTES,
    45,
  ), // skip boot cycle if a run finished this recently
  abandonedRunAfterMinutes: integer(
    "ABANDONED_RUN_AFTER_MINUTES",
    process.env.ABANDONED_RUN_AFTER_MINUTES,
    180,
    { min: 1 },
  ), // stale running rows recovered at startup
  healthFailureThreshold: integer(
    "HEALTH_FAILURE_THRESHOLD",
    process.env.HEALTH_FAILURE_THRESHOLD,
    3,
    { min: 1 },
  ), // fully-failed cycles in a row before /health answers 503

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
