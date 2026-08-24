'use strict';
// HTTP layer for olx.ba's public JSON API (media type olx.v3).
//
// Both endpoints serve anonymous reads — no cookies, no Bearer token, no
// browser. Cloudflare fronts them, so every response is validated as real
// JSON before use: a challenge/interstitial page must surface as an ERROR,
// never as an empty result (an empty-looking success would let the closing
// pass freeze every listing with bogus exit prices).
//
// Endpoints used (verified against live olx.ba, Aug 2026):
//   GET /api/search?category_id=…&canton=…&cities=…&per_page=&page=
//     → { data: [listing…], meta: { total, last_page, current_page,
//         per_page, selected_category }, filters, aggregations }
//   GET /api/listings/<id>
//     → full ad incl. attributes[], price_history[], views, location,
//       created_at/date, user.type, cities[], category

const { USER_AGENT, sleep } = require('./util');
const { parseListingDetail } = require('./parser');

const API_ORIGIN = 'https://olx.ba';

// olx.ba advertises x-ratelimit-limit: 60 per window across these endpoints.
// A full cycle stays far below that (a few dozen search pages + capped detail
// fetches); if the budget ever runs low mid-cycle, back off until it resets
// instead of burning requests into a 429.
const RATE_RESERVE = 10;

class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Rewrite a human-facing /pretraga URL into the API equivalent.
 * Filter params (category_id, canton, cities, attr, …) pass through 1:1;
 * pagination/scrape bookkeeping params are stripped and per_page added.
 * @param {string} searchUrl — configured search URL (/pretraga form)
 * @param {number} [perPage]
 * @returns {URL}
 */
function toApiSearchUrl(searchUrl, perPage) {
  const u = new URL(searchUrl);
  u.protocol = 'https:';
  u.host = 'olx.ba';
  u.hash = '';
  u.pathname = '/api/search';
  u.searchParams.delete('page');
  u.searchParams.delete('olx_scrape');
  if (perPage != null) u.searchParams.set('per_page', String(perPage));
  return u;
}

/** One authenticated-free GET expecting a JSON body. */
async function fetchJson(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(`network error fetching ${url}: ${err.cause?.code || err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(`HTTP ${res.status} for ${url.pathname}${url.search}`, res.status);
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    // Cloudflare challenge / HTML interstitial / truncated gzip — anything
    // non-JSON is unusable regardless of the 200.
    throw new ApiError(
      `non-JSON response for ${url.pathname} (${res.headers.get('content-type')}) — blocked or challenged?`,
      res.status);
  }
  return {
    body,
    remaining: Number(res.headers.get('x-ratelimit-remaining')),
    limit: Number(res.headers.get('x-ratelimit-limit')),
  };
}

/**
 * Fetch one search-result page.
 * @returns {Promise<{items:Array, meta:{total:number,last_page:number,current_page:number},
 *                     remaining:?number, limit:?number}>}
 */
async function fetchSearchPage(apiUrl, timeoutMs) {
  const { body, remaining, limit } = await fetchJson(apiUrl, timeoutMs);
  if (!Array.isArray(body.data) || !body.meta || !Number.isFinite(body.meta.total)) {
    throw new ApiError('search response lacks data[]/meta.total — payload shape changed?');
  }
  return { items: body.data, meta: body.meta, remaining, limit };
}

/** Fetch one ad's full detail object by article id. */
async function fetchListing(articleId, timeoutMs) {
  const { body } = await fetchJson(`${API_ORIGIN}/api/listings/${articleId}`, timeoutMs);
  if (!body || typeof body !== 'object' || body.id !== Number(articleId)) {
    throw new ApiError(`listing ${articleId}: unexpected payload shape`);
  }
  return body;
}

/**
 * Fetch full listings for the given article ids in small concurrent waves
 * with a politeness gap between requests (the shared pacing used by both the
 * per-run enrichment pass and the standalone backfill script).
 *
 * Resolves to one entry per id, in input order: the parsed detail object, or
 * null when that fetch failed (already logged — callers treat null as
 * "keep whatever search-level facts exist").
 *
 * @param {number[]} articleIds
 * @param {{timeoutMs:number, concurrency?:number, delayMs?:number,
 *           onBatch?:(results:Array<?object>, done:number, total:number,
 *                     )=>Promise<void>}} opts
 * @param {(…args:any[])=>void} [log]
 */
async function fetchDetailsInBatches(articleIds, opts, log = () => {}) {
  const { timeoutMs, concurrency = 2, delayMs = 0, onBatch } = opts;
  const all = [];
  let done = 0;
  for (let i = 0; i < articleIds.length; i += Math.max(1, concurrency)) {
    const batch = articleIds.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async id => {
      if (delayMs) await sleep(delayMs);
      try {
        return parseListingDetail(await fetchListing(id, timeoutMs), id);
      } catch (err) {
        log(`⌖ ${id}: detail fetch failed (${String(err.message || err).slice(0, 120)})`);
        return null;
      }
    }));
    all.push(...results);
    done += batch.length;
    if (onBatch) await onBatch(results, done, articleIds.length);
  }
  return all;
}

// Query params olx.ba's API actually honors as filters. A rewritten URL with
// NONE of these returns the ENTIRE site (6.79 M listings when probed with the
// legacy kat= param — the API silently ignores unknown params), so
// scrapeSearch() refuses filterless configs loudly instead.
const FILTER_PARAMS = ['category_id', 'cities', 'canton', 'attr', 'query', 'keyword'];

function hasApiFilter(apiUrl) {
  return FILTER_PARAMS.some(p => apiUrl.searchParams.has(p));
}

module.exports = {
  API_ORIGIN, RATE_RESERVE, ApiError, toApiSearchUrl,
  fetchSearchPage, fetchListing, fetchDetailsInBatches, hasApiFilter,
};
