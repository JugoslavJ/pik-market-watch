"use strict";
// SEARCH_URLS overrides SEARCHES_FILE; missing configuration leaves the scraper idle.

const fs = require("fs");

const SEARCHES_FILE = process.env.SEARCHES_FILE || "/config/searches.json";

const { integer } = require("@pik-market-watch/config");

function normalizeSearchKey(href) {
  const u = new URL(href);
  u.searchParams.delete("page");
  u.searchParams.delete("olx_scrape");
  u.hash = "";
  // Canonicalize query order while keeping common API filters first.
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
  const envUrls = (process.env.SEARCH_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envUrls.length) return envUrls.map((url) => ({ url }));

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

function dedupeBySearchKey(searches) {
  const seen = new Set();
  return searches.filter(({ searchKey }) => {
    if (seen.has(searchKey)) return false;
    seen.add(searchKey);
    return true;
  });
}

module.exports = {
  normalizeSearchKey,
  intervalMinutes: integer(
    "SCRAPE_INTERVAL_MINUTES",
    process.env.SCRAPE_INTERVAL_MINUTES,
    720,
    { min: 1 },
  ),
  runOnce: process.env.RUN_ONCE === "1" || process.argv.includes("--once"),
  maxPages: integer("MAX_PAGES", process.env.MAX_PAGES, 30, { min: 1 }),
  concurrency: integer("CONCURRENCY", process.env.CONCURRENCY, 3, { min: 1 }),
  pageDelayMs: integer("PAGE_DELAY_MS", process.env.PAGE_DELAY_MS, 1500),
  // The API accepts up to at least 500; fewer pages leave rate budget for details.
  perPage: integer("API_PER_PAGE", process.env.API_PER_PAGE, 200, { min: 1 }),
  apiTimeoutMs: integer("API_TIMEOUT_MS", process.env.API_TIMEOUT_MS, 20000, {
    min: 1,
  }),
  healthPort: integer("HEALTH_PORT", process.env.HEALTH_PORT, 9100, {
    min: 1,
    max: 65535,
  }),
  healthBind: (process.env.HEALTH_BIND || "127.0.0.1").trim() || "127.0.0.1",
  maxDetailFetches: integer(
    "MAX_DETAIL_FETCHES",
    process.env.MAX_DETAIL_FETCHES,
    25,
  ),
  detailRefreshDays: integer(
    "DETAIL_REFRESH_DAYS",
    process.env.DETAIL_REFRESH_DAYS,
    7,
    { min: 1 },
  ),
  detailConcurrency: integer(
    "DETAIL_CONCURRENCY",
    process.env.DETAIL_CONCURRENCY,
    2,
    {
      min: 1,
    },
  ),
  detailDelayMs: integer("DETAIL_DELAY_MS", process.env.DETAIL_DELAY_MS, 1200),
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
  ),
  abandonedRunAfterMinutes: integer(
    "ABANDONED_RUN_AFTER_MINUTES",
    process.env.ABANDONED_RUN_AFTER_MINUTES,
    180,
    { min: 1 },
  ),
  healthFailureThreshold: integer(
    "HEALTH_FAILURE_THRESHOLD",
    process.env.HEALTH_FAILURE_THRESHOLD,
    3,
    { min: 1 },
  ),

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
        category: (s.category || "").trim() || null,
        searchKey: normalizeSearchKey(s.url),
      };
    }),
  ),
};
