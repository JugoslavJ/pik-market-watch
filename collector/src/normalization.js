"use strict";

const PRICE_STATES = Object.freeze({
  VALID: "valid",
  UNPRICED: "unpriced",
  INVALID: "invalid",
});

const DEAL_TYPES = Object.freeze({
  SALE: "sale",
  RENT: "rent",
  DAILY_RENT: "daily_rent",
});

const PRICE_POLICY = Object.freeze({
  saleMinimum: 3000,
  rentMinimum: 50,
  dailyRentMinimum: 10,
  // A home priced per m² asks at least this much; lower figures are monthly
  // rents unless the ad says it is for sale.
  homePerSqmMinimum: 1000,
  declaredHomePerSqmMinimum: 300,
  // Land dearer than this per m² is a rent for whatever stands on it.
  landPerSqmMaximum: 500,
  // A holiday home asking less than this is let by the night.
  nightlyMaximum: 300,
  sqmMinimum: 5,
  sqmMaximum: 999999, // about 100 ha; lean.listings.sqm is numeric(8,2)
});

// Garages and prefab units do sell for a few thousand KM.
const SALE_MINIMUMS = Object.freeze({ garages: 1000, prefab: 500 });

// How a "sale" price under the sale minimum is read, by property type:
// advertisers type monthly rents and prices per m² into OLX's sale field.
const LOW_SALE_PRICE_READINGS = Object.freeze({
  land: "per_sqm",
  apartments: "per_sqm_or_rent",
  houses: "per_sqm_or_rent",
  commercial: "rent",
  garages: "rent",
  rooms: "rent",
  vacation_homes: "rent",
  warehouses: "rent",
});
const RENT_TITLE = /iznajm|izmajm|izdaj|izdavanj|\bnajam|\bzakup|podstanar/i;
const SALE_TITLE = /prodaj/i;

// Subcategories of OLX.ba's Nekretnine (category_id=2). Each listing belongs to
// exactly one; ids missing here are newer OLX subcategories.
const PROPERTY_TYPES = Object.freeze({
  23: "apartments",
  2668: "daily_rent",
  24: "houses",
  29: "land",
  25: "commercial",
  26: "vacation_homes",
  30: "garages",
  1193: "prefab",
  2672: "warehouses",
  28: "rooms",
  270: "other",
});
const DAILY_RENT_CATEGORY = 2668;

const UNIX_SECONDS_MAX = 4102444800; // 2100-01-01; rejects millisecond epochs

const NO_PRICE_TEXT =
  /^(?:na\s+upit|po\s+dogovoru|dogovor|cijena\s+na\s+upit|call)$/i;

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

/** Accept complete numeric strings; money uses grouping, measurements use decimals. */
function finiteNumber(value, { integerLike = false } = {}) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  let text = compactNumberString(value);
  if (!text) return null;
  text = text.replace(/(?:KM|BAM|EUR|USD|€|\$)/gi, "");
  text = text.trim();
  if (!text) return null;

  const sign = /^[+-]/.test(text) ? text[0] : "";
  const unsigned = sign ? text.slice(1) : text;
  if (!unsigned || !/^[\d.,]+$/.test(unsigned)) {
    return null;
  }

  const commas = (unsigned.match(/,/g) || []).length;
  const dots = (unsigned.match(/\./g) || []).length;
  if (commas && dots) {
    // The last separator is decimal: 1.234,50 and 1,234.50 both work.
    const decimal =
      unsigned.lastIndexOf(",") > unsigned.lastIndexOf(".") ? "," : ".";
    const grouping = decimal === "," ? /\./g : /,/g;
    const decimalIndex = unsigned.lastIndexOf(decimal);
    const whole = unsigned.slice(0, decimalIndex);
    const fractional = unsigned.slice(decimalIndex + 1);
    if (
      (decimal === "," ? commas : dots) !== 1 ||
      !fractional ||
      !/^\d+$/.test(fractional) ||
      !validIntegerGrouping(whole, decimal === "," ? "." : ",")
    ) {
      return null;
    }
    text = `${sign}${whole.replace(grouping, "")}.${fractional}`;
  } else if (commas) {
    if (commas > 1) {
      if (!validIntegerGrouping(unsigned, ",")) return null;
      text = `${sign}${unsigned.replace(/,/g, "")}`;
    } else if (integerLike && /^\d{1,3},\d{3}$/.test(unsigned)) {
      text = `${sign}${unsigned.replace(",", "")}`;
    } else {
      text = `${sign}${unsigned.replace(",", ".")}`;
    }
  } else if (dots) {
    if (dots > 1) {
      if (!validIntegerGrouping(unsigned, ".")) return null;
      text = `${sign}${unsigned.replace(/\./g, "")}`;
    } else if (integerLike && /^\d{1,3}\.\d{3}$/.test(unsigned)) {
      text = `${sign}${unsigned.replace(".", "")}`;
    } else {
      text = `${sign}${unsigned}`;
    }
  } else {
    text = `${sign}${unsigned}`;
  }

  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function validIntegerGrouping(value, separator) {
  if (/^\d+$/.test(value)) return true;
  const groups = value.split(separator);
  return (
    groups.length > 1 &&
    /^\d{1,3}$/.test(groups[0]) &&
    groups.slice(1).every((group) => /^\d{3}$/.test(group))
  );
}

function propertyTypeOf(categoryId) {
  const id = normalizeId(categoryId);
  return id === null ? null : (PROPERTY_TYPES[id] ?? "other");
}

/** Daily rentals are posted as "sell" with nightly prices; only the category tells them apart. */
function dealTypeFor(categoryId, declaredDeal) {
  return normalizeId(categoryId) === DAILY_RENT_CATEGORY
    ? DEAL_TYPES.DAILY_RENT
    : declaredDeal;
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

// Keep currency per price assertion, including foreign or conflicting evidence.
function priceCurrencyOf(payload) {
  if (!payload || typeof payload !== "object") return null;
  const currencies = new Set();
  const canonical = (value) => {
    const code = String(value).trim().toUpperCase();
    return code === "KM"
      ? "BAM"
      : code === "€"
        ? "EUR"
        : code === "$"
          ? "USD"
          : code;
  };
  for (const key of ["currency", "price_currency", "currency_code"]) {
    if (payload[key] == null || payload[key] === "") continue;
    if (typeof payload[key] !== "string") return "unknown";
    const code = canonical(payload[key]);
    if (!/^[A-Z]{3}$/.test(code)) return "unknown";
    currencies.add(code);
  }
  for (const value of [payload.price, payload.display_price]) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/\b(?:KM|BAM|EUR|USD)\b|[€$]/gi)) {
      currencies.add(canonical(match[0]));
    }
  }
  return currencies.size > 1 ? "conflict" : [...currencies][0] || null;
}

function dealTypeOf(value) {
  if (value === DEAL_TYPES.DAILY_RENT) return value;
  return normalizeDealType(value) || DEAL_TYPES.SALE;
}

const PRICE_MINIMUMS = Object.freeze({
  [DEAL_TYPES.SALE]: [PRICE_POLICY.saleMinimum, "below_sale_minimum"],
  [DEAL_TYPES.RENT]: [PRICE_POLICY.rentMinimum, "below_rent_minimum"],
  [DEAL_TYPES.DAILY_RENT]: [
    PRICE_POLICY.dailyRentMinimum,
    "below_daily_rent_minimum",
  ],
});

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

/** Invalid prices become null; price quality does not determine the deal type. */
function normalizePrice(price, dealType, { displayPrice, propertyType } = {}) {
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
  const [minimum, reason] = PRICE_MINIMUMS[type];
  const floor =
    type === DEAL_TYPES.SALE
      ? (SALE_MINIMUMS[propertyType] ?? minimum)
      : minimum;
  if (parsed < floor) {
    return { price: null, state: PRICE_STATES.INVALID, reason };
  }

  return { price: parsed, state: PRICE_STATES.VALID, reason: null };
}

/** A price per m² becomes the listing's total; without an area there is none. */
function totalFromPerSqm(price, sqm) {
  const asked = finiteNumber(price, { integerLike: true });
  if (asked === null || asked <= 0) {
    return { price: null, state: PRICE_STATES.INVALID, reason: "not_numeric" };
  }
  if (sqm == null || sqm < PRICE_POLICY.sqmMinimum) {
    return {
      price: null,
      state: PRICE_STATES.INVALID,
      reason: "per_sqm_without_area",
    };
  }
  return {
    price: Math.round(asked * sqm),
    state: PRICE_STATES.VALID,
    reason: null,
  };
}

/**
 * Read an asking price against its listing. OLX's sale field also carries
 * monthly rents and prices per m², which fail the sale minimum as totals;
 * those are read as what they are instead of being dropped. An ad that
 * declares itself a sale is never turned into a rental.
 */
function readPrice(
  price,
  { dealType, declared = false, propertyType = null, sqm = null, title = "" },
  { displayPrice } = {},
) {
  const total = (type) => ({
    ...normalizePrice(price, type, { displayPrice, propertyType }),
    dealType: type,
    basis: "total",
  });
  const asked = finiteNumber(price, { integerLike: true });
  // Holiday homes posted as sales or monthly rents at a nightly price.
  if (
    propertyType === "vacation_homes" &&
    asked > 0 &&
    asked < PRICE_POLICY.nightlyMaximum &&
    !(declared && dealTypeOf(dealType) === DEAL_TYPES.SALE)
  )
    return total(DEAL_TYPES.DAILY_RENT);
  // An unknown deal stays unknown unless the price itself says otherwise.
  const posted = { ...total(dealTypeOf(dealType)), dealType };
  const reading = LOW_SALE_PRICE_READINGS[propertyType];
  if (posted.reason !== "below_sale_minimum" || !reading) return posted;

  const text = String(title ?? "");
  if (!declared && RENT_TITLE.test(text)) return total(DEAL_TYPES.RENT);
  const perSqmMinimum =
    declared || SALE_TITLE.test(text)
      ? PRICE_POLICY.declaredHomePerSqmMinimum
      : PRICE_POLICY.homePerSqmMinimum;
  if (
    (reading === "per_sqm" && asked <= PRICE_POLICY.landPerSqmMaximum) ||
    (reading === "per_sqm_or_rent" && asked >= perSqmMinimum)
  ) {
    return {
      ...totalFromPerSqm(price, sqm),
      dealType: DEAL_TYPES.SALE,
      basis: "per_sqm",
    };
  }
  return declared ? posted : total(DEAL_TYPES.RENT);
}

function normalizeArea(value) {
  let n = finiteNumber(value);
  // Three-digit groups are thousands: "7.500" is a 7,500 m² plot, not 7.5 m².
  const text = compactNumberString(value);
  if (n !== null && /^\d{1,3}([.,]\d{3})+$/.test(text))
    n = Number(text.replace(/[.,]/g, ""));
  return n !== null &&
    n >= PRICE_POLICY.sqmMinimum &&
    n <= PRICE_POLICY.sqmMaximum
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

/** History follows the current price's reading: same deal, same basis. */
function normalizeHistoryWithRejections(
  history,
  {
    dealType,
    propertyType,
    basis = "total",
    sqm = null,
    now = Date.now(),
  } = {},
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
    const quality =
      basis === "per_sqm"
        ? totalFromPerSqm(entry.price, sqm)
        : normalizePrice(entry.price, dealType, { propertyType });
    if (quality.state !== PRICE_STATES.VALID) {
      rejected.push({ entry, reason: quality.reason, state: quality.state });
      continue;
    }
    const currency = priceCurrencyOf(entry);
    events.push({
      price: quality.price,
      date,
      ...(currency ? { currency } : {}),
    });
  }
  const seen = new Set();
  const deduped = events
    .sort((a, b) => a.date - b.date || a.price - b.price)
    .filter((event) => {
      const key = `${event.date}:${event.price}:${event.currency || ""}`;
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

module.exports = {
  PRICE_STATES,
  dateFromUnixSeconds,
  dealTypeFor,
  finiteNumber,
  normalizeArea,
  normalizeDealType,
  normalizeHistoryWithRejections,
  normalizeId,
  normalizePrice,
  priceCurrencyOf,
  propertyTypeOf,
  readPrice,
};
