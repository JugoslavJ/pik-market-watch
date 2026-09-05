"use strict";

// Shared payload/price policy.  Keep this module independent of the database so
// search cards, detail responses, historical imports and legacy conversion all
// make the same decisions.

const PRICE_STATES = Object.freeze({
  VALID: "valid",
  UNPRICED: "unpriced",
  INVALID: "invalid",
});

const DEAL_TYPES = Object.freeze({ SALE: "sale", RENT: "rent" });

const PRICE_POLICY = Object.freeze({
  saleMinimum: 3000,
  rentMinimum: 50,
  sqmMinimum: 5,
  sqmMaximum: 500,
  ppm2Minimum: 1,
  ppm2Maximum: 15000,
});

const UNIX_SECONDS_MAX = 4102444800; // 2100-01-01; rejects millisecond epochs

const NO_PRICE_TEXT =
  /^(?:na\s+upit|po\s+dogovoru|dogovor|cijena\s+na\s+upit|call)$/i;

/** Return a positive, safe integer ID or null. */
function normalizeId(value) {
  if (typeof value === "string" && !/^\s*\d+\s*$/.test(value)) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function compactNumberString(value) {
  return String(value ?? "")
    .replace(/[\s\u00a0]/g, "")
    .trim();
}

/**
 * Parse a finite number without accepting a numeric prefix (parseFloat's
 * "12abc" behaviour is especially dangerous for prices).  Money is commonly
 * rendered as 26.000 KM, while measurements use 72.5 or 72,5.
 */
function finiteNumber(value, { integerLike = false } = {}) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  let text = compactNumberString(value);
  if (!text) return null;
  text = text.replace(/(?:KM|BAM|EUR|USD|€|\$)/gi, "");
  text = text.trim();
  if (!text || !/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text)) {
    return null;
  }

  const commas = (text.match(/,/g) || []).length;
  const dots = (text.match(/\./g) || []).length;
  if (commas && dots) {
    // The final separator is the decimal separator; all preceding separators
    // are grouping marks (1.234,50 and 1,234.50 both work).
    const decimal = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
    const grouping = decimal === "," ? /\./g : /,/g;
    text = text.replace(grouping, "").replace(decimal, ".");
  } else if (commas) {
    if (integerLike && /^[-+]?\d{1,3}(?:,\d{3})+$/.test(text)) {
      text = text.replace(/,/g, "");
    } else {
      text = text.replace(",", ".");
    }
  } else if (dots && integerLike && /^[-+]?\d{1,3}(?:\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, "");
  }

  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function normalizeDealType(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (/rent|iznajm|najam|izdavanje|iznajmlj/.test(text)) {
    return DEAL_TYPES.RENT;
  }
  if (/sell|sale|prodaj|kup|prodaja/.test(text)) return DEAL_TYPES.SALE;
  return null;
}

function dealTypeOf(value) {
  return normalizeDealType(value) || DEAL_TYPES.SALE;
}

function reasonForMissingPrice(raw, display) {
  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    return "missing";
  }
  if (typeof raw === "number" && raw === 0) return "zero";
  const rawText = typeof raw === "string" ? raw.trim() : "";
  if (
    NO_PRICE_TEXT.test(rawText) ||
    NO_PRICE_TEXT.test(String(display ?? "").trim())
  ) {
    return "not_priced";
  }
  return null;
}

/**
 * Normalize one current or historical price.  `price` is always null unless
 * the state is valid; classification is never inferred from price quality.
 */
function normalizePrice(price, dealType, { displayPrice } = {}) {
  const missingReason = reasonForMissingPrice(price, displayPrice);
  if (missingReason) {
    return { price: null, state: PRICE_STATES.UNPRICED, reason: missingReason };
  }

  const parsed = finiteNumber(price, { integerLike: true });
  if (parsed === null) {
    return { price: null, state: PRICE_STATES.INVALID, reason: "not_numeric" };
  }
  if (parsed === 0) {
    return { price: null, state: PRICE_STATES.UNPRICED, reason: "zero" };
  }
  if (parsed < 0) {
    return { price: null, state: PRICE_STATES.INVALID, reason: "negative" };
  }

  const type = dealTypeOf(dealType);
  const minimum =
    type === DEAL_TYPES.RENT
      ? PRICE_POLICY.rentMinimum
      : PRICE_POLICY.saleMinimum;
  if (parsed < minimum) {
    return {
      price: null,
      state: PRICE_STATES.INVALID,
      reason:
        type === DEAL_TYPES.RENT ? "below_rent_minimum" : "below_sale_minimum",
    };
  }

  return { price: parsed, state: PRICE_STATES.VALID, reason: null };
}

function normalizeArea(value) {
  const n = finiteNumber(value);
  return n !== null &&
    n >= PRICE_POLICY.sqmMinimum &&
    n <= PRICE_POLICY.sqmMaximum
    ? n
    : null;
}

function normalizePpm2(price, sqm, dealType) {
  const area = normalizeArea(sqm);
  if (dealTypeOf(dealType) === DEAL_TYPES.RENT || price == null || area == null)
    return null;
  const n = Math.round(price / area);
  return Number.isFinite(n) &&
    n >= PRICE_POLICY.ppm2Minimum &&
    n <= PRICE_POLICY.ppm2Maximum
    ? n
    : null;
}

/** Unix seconds only; milliseconds and fractional values are rejected. */
function normalizeUnixSeconds(value) {
  const n = finiteNumber(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 && n <= UNIX_SECONDS_MAX
    ? n
    : null;
}

function dateFromUnixSeconds(value) {
  const seconds = normalizeUnixSeconds(value);
  return seconds === null ? null : new Date(seconds * 1000);
}

function historyDate(entry) {
  if (!entry || typeof entry !== "object") return null;
  return normalizeUnixSeconds(entry.created_at ?? entry.date);
}

/**
 * Normalize API and stored history into sorted, exact-deduplicated events.
 * Invalid prices/timestamps are omitted from the canonical timeline.  The
 * caller can use normalizeHistoryWithRejections when quarantine information is
 * needed; no import timestamp is ever substituted.
 */
function normalizePriceHistory(history, { dealType, now = Date.now() } = {}) {
  const input = Array.isArray(history) ? history : parseJsonArray(history);
  if (!input) return [];
  const currentSeconds = Math.floor(new Date(now).getTime() / 1000);
  const events = [];
  for (const entry of input) {
    const date = historyDate(entry);
    if (date === null || date > currentSeconds) continue;
    const quality = normalizePrice(entry.price, dealType);
    if (quality.state !== PRICE_STATES.VALID) continue;
    events.push({ price: quality.price, date });
  }

  const seen = new Set();
  return events
    .sort((a, b) => a.date - b.date || a.price - b.price)
    .filter((event) => {
      const key = `${event.date}:${event.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeHistoryWithRejections(
  history,
  { dealType, now = Date.now() } = {},
) {
  const input = Array.isArray(history) ? history : parseJsonArray(history);
  if (!input) return { events: [], rejected: [] };
  const currentSeconds = Math.floor(new Date(now).getTime() / 1000);
  const events = [];
  const rejected = [];
  for (const entry of input) {
    const date = historyDate(entry);
    if (date === null) {
      rejected.push({ entry, reason: "invalid_timestamp" });
      continue;
    }
    if (date > currentSeconds) {
      rejected.push({ entry, reason: "future_timestamp" });
      continue;
    }
    const quality = normalizePrice(entry.price, dealType);
    if (quality.state !== PRICE_STATES.VALID) {
      rejected.push({ entry, reason: quality.reason, state: quality.state });
      continue;
    }
    events.push({ price: quality.price, date });
  }
  const seen = new Set();
  const deduped = events
    .sort((a, b) => a.date - b.date || a.price - b.price)
    .filter((event) => {
      const key = `${event.date}:${event.price}`;
      if (seen.has(key)) {
        rejected.push({ entry: event, reason: "duplicate" });
        return false;
      }
      seen.add(key);
      return true;
    });
  return { events: deduped, rejected };
}

function parseJsonArray(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Named legacy entrypoint makes the policy explicit for package 05 without a
// second implementation.  Stored rows use {price, date}; API rows use
// {price, created_at}; both are handled by normalizePriceHistory().
const normalizeLegacyPriceHistory = normalizePriceHistory;

module.exports = {
  DEAL_TYPES,
  PRICE_POLICY,
  PRICE_STATES,
  dateFromUnixSeconds,
  dealTypeOf,
  finiteNumber,
  normalizeArea,
  normalizeDealType,
  normalizeHistoryWithRejections,
  normalizeId,
  normalizeLegacyPriceHistory,
  normalizePpm2,
  normalizePrice,
  normalizePriceHistory,
  normalizeUnixSeconds,
};
