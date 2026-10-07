"use strict";

const BIH_BBOX = { latMin: 42.4, latMax: 46.4, lonMin: 15.5, lonMax: 19.9 };

const MAPPER_BUILD_VERSION = String(
  process.env.MAPPER_BUILD_VERSION || require("../package.json").version,
)
  .trim()
  .slice(0, 128);

const {
  dateFromUnixSeconds,
  finiteNumber,
  normalizeArea,
  normalizeDealType,
  normalizeHistoryWithRejections,
  normalizeId,
  normalizePrice,
  priceCurrencyOf,
} = require("./normalization");

function inBiH(lat, lon) {
  return (
    lat >= BIH_BBOX.latMin &&
    lat <= BIH_BBOX.latMax &&
    lon >= BIH_BBOX.lonMin &&
    lon <= BIH_BBOX.lonMax
  );
}

function numOrNull(v, min, max) {
  const n = finiteNumber(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function smallInt(v, min, max) {
  const n = numOrNull(v, -Infinity, Infinity);
  if (n === null) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

function textOrNull(v, maxLen) {
  const s = String(v ?? "").trim();
  return s && s.length <= maxLen ? s : null;
}

function boolFromText(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (/^(da|yes|true|1)$/.test(s)) return true;
  if (/^(ne|no|false|0)$/.test(s)) return false;
  return null;
}

function furnishedFromText(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (/^polu/.test(s)) return null;
  const b = boolFromText(s);
  if (b !== null) return b;
  if (s.includes("namje\u0161ten") || s.includes("namjesten")) {
    return !s.includes("ne");
  }
  return null;
}

// Unknown attribute codes remain available in raw characteristics.
const CHAR_CODE_HANDLERS = {
  "broj-soba": (v, o) => {
    o.roomsDetail = textOrNull(v, 40);
  },
  "broj-kupatila": (v, o) => {
    o.bathrooms = smallInt(v, 0, 50);
  },
  "broj-etaza": (v, o) => {
    o.unitLevels = smallInt(v, 1, 50);
  },
  sprat: (v, o) => {
    o.floorNum = smallInt(v, -5, 200);
  },
  "ukupno-spratova": (v, o) => {
    o.floorsTotal = smallInt(v, 1, 200);
  },
  grijanje: (v, o) => {
    o.heating = textOrNull(v, 60);
  },
  opremljenost: (v, o) => {
    o.furnished = furnishedFromText(v);
  },
  namjesten: (v, o) => {
    if (o.furnished == null) o.furnished = boolFromText(v);
  },
  stanje: (v, o) => {
    o.condition = textOrNull(v, 60);
  },
  parking: (v, o) => {
    o.parking = boolFromText(v);
  },
  garaza: (v, o) => {
    o.garage = boolFromText(v);
  },
  lift: (v, o) => {
    o.elevator = boolFromText(v);
  },
  "godina-izgradnje": (v, o) => {
    o.yearBuilt = smallInt(v, 1800, 2100);
  },
  "okucnica-kvadratura": (v, o) => {
    o.plotSqm = numOrNull(v, 1, 1000000);
  },
  "primarna-orjentacija": (v, o) => {
    o.orientation = textOrNull(v, 40);
  },
};

const SELLER_TYPES = new Set(["shop", "private"]);

function specialLabelValue(item, label) {
  const hit = (
    Array.isArray(item.special_labels) ? item.special_labels : []
  ).find((l) => l && l.label === label);
  return hit ? hit.value : null;
}

function pinOf(loc) {
  const point =
    loc && loc.location && typeof loc.location === "object"
      ? loc.location
      : loc;
  const lat = finiteNumber(point && point.lat),
    lon = finiteNumber(point && point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inBiH(lat, lon)) {
    return { latitude: null, longitude: null };
  }
  return { latitude: lat, longitude: lon };
}

function mapSearchItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = normalizeId(item.id);
  if (id === null) return null;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (title.length <= 2) return null;

  const url = `https://olx.ba/artikal/${id}`;

  const displayPrice =
    typeof item.display_price === "string" ? item.display_price.trim() : "";
  const dealType = normalizeDealType(item.listing_type);
  const isRent = dealType === "rent";
  const priceQuality = normalizePrice(item.price, dealType, {
    displayPrice,
  });
  const price = priceQuality.price;
  const priceText =
    displayPrice ||
    (priceQuality.state === "unpriced" ? "Na upit" : String(item.price ?? ""));
  const isStudio = /garsonjera/i.test(title);

  const sqm = normalizeArea(specialLabelValue(item, "Kvadrata"));

  let rooms = isStudio ? "0" : null;
  if (!isStudio) {
    const roomsRaw = specialLabelValue(item, "Broj Soba");
    if (roomsRaw != null) {
      const s = String(roomsRaw);
      const pm = s.match(/\((\d+)\)/); // "trosoban (3)"
      if (pm) rooms = pm[1];
      else if (/^\d+\+?$/.test(s.trim())) rooms = s.trim();
    }
  }

  return {
    articleId: id,
    title,
    url,
    sqm,
    rooms,
    price,
    priceText,
    priceCurrency: priceCurrencyOf(item),
    isRent,
    dealType,
    priceState: priceQuality.state,
    priceReason: priceQuality.reason,
    pricePresent: Object.prototype.hasOwnProperty.call(item, "price"),
    ...pinOf(item.location),
    // Search dates are renewal timestamps, not publication dates.
    renewedAt: dateFromUnixSeconds(item.date),
    sellerType: SELLER_TYPES.has(item.user_type) ? item.user_type : null,
    apiStatus: typeof item.status === "string" ? item.status : null,
  };
}

/** Rejected entries make a page non-authoritative for closing listings. */
function mapSearchItems(items) {
  if (!Array.isArray(items))
    return { cards: [], rejected: [{ reason: "data_not_array" }] };

  const cards = [];
  const rejected = [];
  for (const item of items) {
    try {
      const card = mapSearchItem(item);
      if (card) {
        cards.push(card);
        continue;
      }
      let reason = "invalid_item";
      if (!item || typeof item !== "object") reason = "not_an_object";
      else if (normalizeId(item.id) === null) reason = "invalid_id";
      else if (typeof item.title !== "string" || item.title.trim().length <= 2)
        reason = "invalid_title";
      rejected.push({ reason });
    } catch (error) {
      rejected.push({
        reason: "parser_exception",
        error: String(error?.message || error).slice(0, 160),
      });
    }
  }
  return { cards, rejected };
}

function mapSearchPage(payload) {
  if (
    !payload ||
    !Array.isArray(payload.data) ||
    !payload.meta ||
    !Number.isFinite(Number(payload.meta.total))
  ) {
    throw new Error("search payload lacks data[]/meta.total");
  }
  const parsed = mapSearchItems(payload.data);
  return {
    cards: parsed.cards,
    rejected: parsed.rejected,
    meta: {
      total: Number(payload.meta.total),
      lastPage: Number(payload.meta.last_page),
      currentPage: Number(payload.meta.current_page),
    },
  };
}

// ad detail (/api/listings/<id>)
function mapListingDetail(json, fallbackId) {
  if (!json || typeof json !== "object") return null;
  const articleId = normalizeId(json.id) ?? normalizeId(fallbackId);
  if (articleId === null) return null;

  const displayPrice =
    typeof json.display_price === "string" ? json.display_price.trim() : "";
  const attributes = Array.isArray(json.attributes) ? json.attributes : [];
  // listing_type follows the posting category, which advertisers often get
  // wrong; the ad's own "vrsta-oglasa" (ad kind) attribute is more reliable.
  const declaredDeal = normalizeDealType(
    attributes.find((attr) => attr && attr.attr_code === "vrsta-oglasa")?.value,
  );
  const dealType = declaredDeal ?? normalizeDealType(json.listing_type);
  const isRent = dealType === "rent";
  const priceQuality = normalizePrice(json.price, dealType, { displayPrice });
  const historyResult = normalizeHistoryWithRejections(json.price_history, {
    dealType,
  });

  const detail = {
    articleId,
    ...pinOf(json.location),
    sqm: null,
    publishedAt: dateFromUnixSeconds(json.created_at),
    renewedAt: dateFromUnixSeconds(json.date),
    price: priceQuality.price,
    priceCurrency: priceCurrencyOf(json),
    priceText:
      displayPrice ||
      (priceQuality.state === "unpriced"
        ? "Na upit"
        : String(json.price ?? "")),
    isRent,
    dealType,
    priceState: priceQuality.state,
    priceReason: priceQuality.reason,
    pricePresent: Object.prototype.hasOwnProperty.call(json, "price"),
    sellerType:
      json.user && SELLER_TYPES.has(json.user.type) ? json.user.type : null,
    roomsDetail: null,
    bathrooms: null,
    floorNum: null,
    floorsTotal: null,
    unitLevels: null,
    heating: null,
    furnished: null,
    condition: null,
    parking: null,
    garage: null,
    elevator: null,
    yearBuilt: null,
    plotSqm: null,
    orientation: null,
    views: smallInt(json.views, 0, 100000000),
    favorites: smallInt(json.favorites, 0, 1000000),
    characteristics: {},
    apiStatus: typeof json.status === "string" ? json.status : null,
    // Preserve source evidence alongside the normalized, valid-only timeline.
    sourcePriceHistory: Array.isArray(json.price_history)
      ? json.price_history.map((entry) => ({ ...entry }))
      : null,
    apiPriceHistory: Array.isArray(json.price_history)
      ? historyResult.events
      : null,
    priceHistoryRejections: historyResult.rejected,
  };

  for (const attr of attributes) {
    const code = attr && attr.attr_code;
    if (!code || detail.characteristics[code] !== undefined) continue;
    const raw = attr.value;
    if (raw == null) continue;
    const trimmed = String(raw).trim();
    if (trimmed === "") continue;

    detail.characteristics[code] = finiteNumber(trimmed) ?? trimmed;

    const handler = CHAR_CODE_HANDLERS[code];
    if (handler) handler(trimmed, detail);
  }

  // The detailed furnishing description takes precedence over a coarse yes/no flag.
  if (detail.characteristics.opremljenost != null) {
    detail.furnished = furnishedFromText(detail.characteristics.opremljenost);
  }

  detail.sqm = normalizeArea(detail.characteristics.kvadrata);

  return detail;
}

module.exports = {
  MAPPER_BUILD_VERSION,
  mapSearchItem,
  mapSearchItems,
  mapSearchPage,
  mapListingDetail,
};
