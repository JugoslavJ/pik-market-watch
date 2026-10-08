"use strict";

const { USER_AGENT, sleep } = require("./util");
const { mapListingDetail, MAPPER_BUILD_VERSION } = require("./payload-mapper");

const API_ORIGIN = "https://olx.ba";

// Pause before exhausting the rate window shared by search and detail requests.
const RATE_RESERVE = 10;
// OLX counts requests in fixed one-minute windows: remaining jumps back to the limit.
const RATE_WINDOW_MS = 61_000;

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

// Archive only these diagnostic headers.
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

function trustedTarget(target) {
  return target.origin === API_ORIGIN;
}

function errorContext(error, request, response, diagnostic) {
  error.requestMetadata = request;
  error.responseMetadata = response;
  error.diagnostic = diagnostic;
  if (diagnostic?.kind && error.kind == null) error.kind = diagnostic.kind;
  return error;
}

class ApiError extends Error {
  constructor(message, status = null, { kind = null, retryable = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** Shared request budget for all calls made during one scrape cycle. */
class RateBudget {
  constructor({
    reserve = RATE_RESERVE,
    cooldownMs = 65000,
    wait = sleep,
    now = Date.now,
    onLow = () => {},
  } = {}) {
    this.reserve = Math.max(0, Number(reserve) || 0);
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.wait = wait;
    this.now = now;
    this.onLow = onLow;
    this.blockedUntil = 0;
    this.lowHandled = false;
    this.remaining = null;
    this.limit = null;
    this.windowStartedAt = null;
  }

  async waitIfBlocked() {
    const delay = Math.ceil(this.blockedUntil - this.now());
    if (delay > 0) {
      await this.wait(delay);
      this.blockedUntil = 0;
    }
  }

  observe(headers) {
    const remaining = numericHeader(headers, "x-ratelimit-remaining");
    const limit = numericHeader(headers, "x-ratelimit-limit");
    this.observeValues(remaining, limit);
  }

  observeValues(remaining, limit = null) {
    // A rising count starts a new window. Responses arrive after the window
    // opened, so this estimate never makes the reset look earlier than it is.
    if (
      remaining != null &&
      (this.remaining == null || remaining > this.remaining)
    )
      this.windowStartedAt = this.now();
    if (remaining != null) this.remaining = remaining;
    if (limit != null) this.limit = limit;
    // A reset window can reach the low-water mark again in the same cycle.
    if (remaining != null && remaining >= this.reserve) this.lowHandled = false;
    if (remaining != null && remaining < this.reserve && !this.lowHandled) {
      this.lowHandled = true;
      // Wait for the window to reset; the cooldown bounds the wait.
      this.blockedUntil = Math.max(
        this.blockedUntil,
        Math.min(
          this.now() + this.cooldownMs,
          this.windowStartedAt + RATE_WINDOW_MS,
        ),
      );
      this.onLow(remaining, limit);
    }
  }

  onRateLimited(retryAfterMs) {
    const delay = retryAfterMs ?? this.cooldownMs;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
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

/** Cancel the body stream once it exceeds the byte limit. */
async function readBodyCapped(res, maxBytes) {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new ApiError(`response body exceeds ${maxBytes} bytes`);
    return text;
  }
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

async function fetchJson(url, timeoutMs, policy = {}) {
  const target = url instanceof URL ? url : new URL(String(url));
  const request = requestMetadata(target);
  if (!trustedTarget(target)) {
    throw errorContext(
      new ApiError(`refusing API request to untrusted origin ${target.origin}`),
      request,
      null,
      { kind: "origin", message: "API target origin is not trusted" },
    );
  }
  const maxAttempts = policy.maxAttempts ?? MAX_REQUEST_ATTEMPTS;
  const wait = policy.wait ?? sleep;
  const random = policy.random ?? Math.random;
  const rateBudget = policy.rateBudget;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (rateBudget) await rateBudget.waitIfBlocked();
    let res;
    try {
      res = await fetch(target, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
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
    if (rateBudget) rateBudget.observe(res.headers);
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
      if (rateBudget && res.status === 429)
        rateBudget.onRateLimited(retryAfter);
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
      // A 200 response can still be a challenge page; do not retry invalid JSON.
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
      requestMetadata: request,
      responseMetadata: response,
      remaining: numericHeader(res.headers, "x-ratelimit-remaining"),
      limit: numericHeader(res.headers, "x-ratelimit-limit"),
    };
  }
}

function validateListingId(articleId) {
  if (
    (typeof articleId !== "number" &&
      !(typeof articleId === "string" && /^\d+$/.test(articleId.trim()))) ||
    !Number.isSafeInteger(Number(articleId)) ||
    Number(articleId) <= 0
  ) {
    throw new ApiError(
      `listing id must be a positive safe integer; received ${JSON.stringify(articleId)}`,
      null,
      { kind: "input" },
    );
  }
  return Number(articleId);
}

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
    error.sourcePayload = body;
    throw error;
  }
  return {
    items: body.data,
    meta: body.meta,
    remaining,
    limit,
    sourcePayload: body,
    requestMetadata: result.requestMetadata,
    responseMetadata: result.responseMetadata,
  };
}

async function fetchListing(
  articleId,
  timeoutMs,
  { includeMetadata = false, rateBudget } = {},
) {
  const id = validateListingId(articleId);
  const result = await fetchJson(
    `${API_ORIGIN}/api/listings/${id}`,
    timeoutMs,
    { rateBudget },
  );
  const { body } = result;
  if (!body || typeof body !== "object" || body.id !== id) {
    const error = errorContext(
      new ApiError(`listing ${articleId}: unexpected payload shape`),
      result.requestMetadata,
      result.responseMetadata,
      { kind: "schema", message: "listing response id did not match request" },
    );
    error.sourcePayload = body;
    throw error;
  }
  return includeMetadata ? result : body;
}

/** Return mapped details in input order, with null for failed requests. */
async function fetchDetailsInBatches(articleIds, opts, log = () => {}) {
  const {
    timeoutMs,
    concurrency = 2,
    delayMs = 0,
    onBatch,
    onError,
    rateBudget,
    wait = sleep,
  } = opts;
  const all = [];
  let done = 0;
  for (let i = 0; i < articleIds.length; i += Math.max(1, concurrency)) {
    if (i > 0 && delayMs > 0) await wait(delayMs);
    const batch = articleIds.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const fetched = await fetchListing(id, timeoutMs, {
            includeMetadata: true,
            rateBudget,
          });
          const sourcePayload = fetched.body;
          let parsed;
          try {
            parsed = mapListingDetail(sourcePayload, id);
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
          parsed.sourceBuildVersion = MAPPER_BUILD_VERSION;
          return parsed;
        } catch (err) {
          // Diagnostic failures must not turn a handled fetch error into a failed batch.
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

// Unknown parameters are ignored upstream; require a filter to avoid fetching the whole site.
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

module.exports = {
  ApiError,
  RateBudget,
  RATE_RESERVE,
  MAX_BODY_BYTES,
  parseRetryAfter,
  readBodyCapped,
  fetchJson,
  toApiSearchUrl,
  fetchSearchPage,
  fetchListing,
  fetchDetailsInBatches,
  hasApiFilter,
};
