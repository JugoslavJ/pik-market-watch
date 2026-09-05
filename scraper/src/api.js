"use strict";
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

const { USER_AGENT, sleep } = require("./util");
const { parseListingDetail, PARSER_BUILD_VERSION } = require("./parser");

const API_ORIGIN = "https://olx.ba";

// olx.ba advertises x-ratelimit-limit: 60 per window across these endpoints.
// A full cycle stays far below that (a few dozen search pages + capped detail
// fetches); if the budget ever runs low mid-cycle, back off until it resets
// instead of burning requests into a 429.
const RATE_RESERVE = 10;

// Hard ceiling on upstream response bodies: a broken or hostile endpoint (or
// an oversized Cloudflare interstitial) can never balloon memory past this —
// the fetch fails cleanly instead of OOM-killing the container.
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const REQUEST_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": USER_AGENT,
};

function headerValue(headers, name) {
  return headers?.get?.(name) ?? null;
}

// Keep archives useful without copying arbitrary upstream headers (which may
// grow unexpectedly or contain credentials in a future deployment).
function responseHeaders(headers) {
  const names = [
    "content-type",
    "content-length",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "retry-after",
    "etag",
    "last-modified",
  ];
  return Object.fromEntries(
    names
      .map((name) => [name, headerValue(headers, name)])
      .filter(([, value]) => value != null),
  );
}

function requestMetadata(url) {
  return {
    method: "GET",
    url: url.href,
    headers: { accept: REQUEST_HEADERS.Accept, "user-agent": USER_AGENT },
  };
}

function errorContext(error, request, response, diagnostic) {
  error.requestMetadata = request;
  error.responseMetadata = response;
  error.diagnostic = diagnostic;
  return error;
}

class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function numericHeader(headers, name) {
  const value = headers.get(name);
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Convert Retry-After seconds or HTTP date into a bounded delay. */
function parseRetryAfter(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  let delay;
  if (/^\d+(?:\.\d+)?$/.test(raw)) delay = Number(raw) * 1000;
  else {
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return null;
    delay = timestamp - now;
  }
  if (!Number.isFinite(delay) || delay < 0) return 0;
  return Math.min(MAX_RETRY_DELAY_MS, delay);
}

function retryDelay(attempt, retryAfterMs, random = Math.random) {
  if (retryAfterMs != null) return retryAfterMs;
  const exponential = Math.min(
    MAX_RETRY_DELAY_MS,
    RETRY_BASE_MS * 2 ** (attempt - 1),
  );
  return Math.min(
    MAX_RETRY_DELAY_MS,
    exponential + Math.floor(random() * RETRY_BASE_MS),
  );
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
  u.protocol = "https:";
  u.host = "olx.ba";
  u.hash = "";
  u.pathname = "/api/search";
  u.searchParams.delete("page");
  u.searchParams.delete("olx_scrape");
  if (perPage != null) u.searchParams.set("per_page", String(perPage));
  return u;
}

/**
 * Drain a fetch body as text while enforcing a byte ceiling. `res.text()`
 * would happily buffer any size; this cancels the stream once the cap is
 * crossed, so hostile/broken upstreams fail fast instead of eating RAM.
 */
async function readBodyCapped(res, maxBytes) {
  if (!res.body) return res.text(); // no stream (mocks/tests) — uncapped fallback
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(`response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One authenticated-free GET expecting a JSON body. */
async function fetchJson(url, timeoutMs, policy = {}) {
  const target = url instanceof URL ? url : new URL(String(url));
  const request = requestMetadata(target);
  const maxAttempts = policy.maxAttempts ?? MAX_REQUEST_ATTEMPTS;
  const wait = policy.wait ?? sleep;
  const random = policy.random ?? Math.random;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(target, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await wait(retryDelay(attempt, null, random));
        continue;
      }
      throw errorContext(
        new ApiError(
          `network error fetching ${url}: ${err.cause?.code || err.message}`,
        ),
        request,
        { attempts: attempt },
        {
          kind: "network",
          message: String(err.cause?.code || err.message).slice(0, 500),
        },
      );
    }
    // Cheap pre-flight: honor a declared Content-Length before reading at all.
    const declared = numericHeader(res.headers, "content-length");
    if (declared != null && declared > MAX_BODY_BYTES)
      throw errorContext(
        new ApiError(
          `response too large (${declared} > ${MAX_BODY_BYTES} bytes) for ${target.pathname}`,
        ),
        request,
        {
          status: res.status,
          contentType: headerValue(res.headers, "content-type"),
          bytes: declared,
          attempts: attempt,
          headers: responseHeaders(res.headers),
        },
        { kind: "body_limit", message: `declared ${declared} bytes` },
      );
    let text;
    try {
      text = await readBodyCapped(res, MAX_BODY_BYTES);
    } catch (error) {
      throw errorContext(
        error,
        request,
        {
          status: res.status,
          contentType: headerValue(res.headers, "content-type"),
          attempts: attempt,
          headers: responseHeaders(res.headers),
        },
        {
          kind: "body_limit",
          message: String(error.message || error).slice(0, 500),
        },
      );
    }
    const response = {
      status: res.status,
      contentType: headerValue(res.headers, "content-type"),
      bytes: Buffer.byteLength(text, "utf8"),
      attempts: attempt,
      headers: responseHeaders(res.headers),
    };
    if (!res.ok) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts) {
        await wait(retryDelay(attempt, retryAfter, random));
        continue;
      }
      const error = new ApiError(
        `HTTP ${res.status} for ${target.pathname}${target.search}`,
        res.status,
      );
      error.retryAfterMs = retryAfter;
      throw errorContext(error, request, response, {
        kind: "http",
        status: res.status,
        body: text.slice(0, 2048),
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch (_) {
      // Cloudflare challenge / HTML interstitial / truncated gzip — anything
      // non-JSON is unusable regardless of the 200. Do not blindly retry it.
      throw errorContext(
        new ApiError(
          `non-JSON response for ${target.pathname} (${res.headers.get("content-type")}) — blocked or challenged?`,
          res.status,
        ),
        request,
        response,
        { kind: "decode", body: text.slice(0, 2048) },
      );
    }
    return {
      body,
      sourcePayload: body,
      requestMetadata: request,
      responseMetadata: response,
      remaining: numericHeader(res.headers, "x-ratelimit-remaining"),
      limit: numericHeader(res.headers, "x-ratelimit-limit"),
    };
  }
}

/**
 * Fetch one search-result page.
 * @returns {Promise<{items:Array, meta:{total:number,last_page:number,current_page:number},
 *                     remaining:?number, limit:?number}>}
 */
async function fetchSearchPage(apiUrl, timeoutMs, policy) {
  const result = await fetchJson(apiUrl, timeoutMs, policy);
  const { body, remaining, limit } = result;
  if (
    !Array.isArray(body.data) ||
    !body.meta ||
    !Number.isFinite(body.meta.total)
  ) {
    const error = errorContext(
      new ApiError(
        "search response lacks data[]/meta.total — payload shape changed?",
      ),
      result.requestMetadata,
      result.responseMetadata,
      { kind: "schema", message: "search response lacks data[]/meta.total" },
    );
    error.sourcePayload = result.sourcePayload;
    throw error;
  }
  return {
    items: body.data,
    meta: body.meta,
    remaining,
    limit,
    sourcePayload: result.sourcePayload,
    requestMetadata: result.requestMetadata,
    responseMetadata: result.responseMetadata,
  };
}

/** Fetch one ad's full detail object by article id. */
async function fetchListing(
  articleId,
  timeoutMs,
  { includeMetadata = false } = {},
) {
  const result = await fetchJson(
    `${API_ORIGIN}/api/listings/${articleId}`,
    timeoutMs,
  );
  const { body } = result;
  if (!body || typeof body !== "object" || body.id !== Number(articleId)) {
    const error = errorContext(
      new ApiError(`listing ${articleId}: unexpected payload shape`),
      result.requestMetadata,
      result.responseMetadata,
      { kind: "schema", message: "listing response id did not match request" },
    );
    error.sourcePayload = result.sourcePayload;
    throw error;
  }
  return includeMetadata ? result : body;
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
 *                     )=>Promise<void>,
 *           onError?:(articleId:number,error:Error)=>Promise<void>}} opts
 * @param {(…args:any[])=>void} [log]
 */
async function fetchDetailsInBatches(articleIds, opts, log = () => {}) {
  const { timeoutMs, concurrency = 2, delayMs = 0, onBatch, onError } = opts;
  const all = [];
  let done = 0;
  for (let i = 0; i < articleIds.length; i += Math.max(1, concurrency)) {
    const batch = articleIds.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (id) => {
        if (delayMs) await sleep(delayMs);
        try {
          const fetched = await fetchListing(id, timeoutMs, {
            includeMetadata: true,
          });
          const sourcePayload = fetched.body;
          let parsed;
          try {
            parsed = parseListingDetail(sourcePayload, id);
          } catch (error) {
            error.requestMetadata = fetched.requestMetadata;
            error.responseMetadata = fetched.responseMetadata;
            error.sourcePayload = sourcePayload;
            error.diagnostic = {
              kind: "parser",
              message: String(error.message || error).slice(0, 500),
            };
            throw error;
          }
          if (!parsed)
            throw Object.assign(
              new ApiError(
                `listing ${id}: detail payload was rejected by the parser`,
              ),
              {
                requestMetadata: fetched.requestMetadata,
                responseMetadata: fetched.responseMetadata,
                sourcePayload,
                diagnostic: {
                  kind: "parser",
                  message: "detail payload was rejected by the parser",
                },
              },
            );
          parsed.sourcePayload = sourcePayload;
          parsed.sourceRequestMetadata = fetched.requestMetadata;
          parsed.sourceResponseMetadata = fetched.responseMetadata;
          parsed.sourceBuildVersion = PARSER_BUILD_VERSION;
          return parsed;
        } catch (err) {
          // Keep the historical null result contract for callers while
          // allowing durable workers to persist a per-request outcome. An
          // observability callback must never turn a handled fetch failure
          // into a failed batch, so reporting errors are logged and ignored.
          if (onError) {
            try {
              await onError(id, err);
            } catch (reportError) {
              log(
                `⚠ ${id}: detail outcome recording failed (${String(
                  reportError.message || reportError,
                ).slice(0, 120)})`,
              );
            }
          }
          log(
            `⌖ ${id}: detail fetch failed (${String(err.message || err).slice(0, 120)})`,
          );
          return null;
        }
      }),
    );
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
const FILTER_PARAMS = [
  "category_id",
  "cities",
  "canton",
  "attr",
  "query",
  "keyword",
];

function hasApiFilter(apiUrl) {
  return FILTER_PARAMS.some((p) => apiUrl.searchParams.has(p));
}

// Exported surface = what callers actually consume. RATE_RESERVE is read by
// scrapeSearch()'s throttle; everything else here is called directly.
// (API_ORIGIN and ApiError stay module-internal — no external consumer;
// readBodyCapped / MAX_BODY_BYTES are exported for their unit tests.)
module.exports = {
  ApiError,
  RATE_RESERVE,
  MAX_BODY_BYTES,
  MAX_REQUEST_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  parseRetryAfter,
  retryDelay,
  readBodyCapped,
  fetchJson,
  toApiSearchUrl,
  fetchSearchPage,
  fetchListing,
  fetchDetailsInBatches,
  hasApiFilter,
};
