'use strict';
// Parsers: olx.ba JSON API payloads → the shapes the DB layer expects.
// Pure functions — no network, no database — so everything here unit-tests
// against the recorded fixtures in test/fixtures/.
//
// Search-item fields consumed (media type olx.v3):
//   id, title, price, display_price, listing_type ('sell'|'rent', …),
//   special_labels: [{label:'Kvadrata', value}, {label:'Broj Soba', value}],
//   location:{lat,lon}, date (unix renewal/bump stamp), user_type, status
// Listing-detail adds: attributes[] ({attr_code, value, …}), views, favorites,
//   created_at (true publish time), price_history[], user.type
//
// The coercion helpers and the attr_code→column handlers below are carried
// over verbatim from the HTML-scraping era (git history: parser.js parseDetail)
// — the API exposes the very same attr_code:value pairs the Nuxt state had.

const BIH_BBOX = { latMin: 42.4, latMax: 46.4, lonMin: 15.5, lonMax: 19.9 };

function inBiH(lat, lon) {
  return lat >= BIH_BBOX.latMin && lat <= BIH_BBOX.latMax &&
         lon >= BIH_BBOX.lonMin && lon <= BIH_BBOX.lonMax;
}

// ── value coercion helpers ───────────────────────────────────────────────────

function cleanNumberString(v) {
  return String(v ?? '').replace(/\s/g, '');
}

/** Tolerant float: handles "1.636", "72,5", "1636". Returns null outside [min,max]. */
function numOrNull(v, min, max) {
  const s = cleanNumberString(v);
  if (!s) return null;
  const hasComma = s.includes(','), hasDot = s.includes('.');
  let t = s;
  if (hasComma && hasDot) {
    t = s.lastIndexOf('.') > s.lastIndexOf(',')
      ? s.replace(/,/g, '')
      : s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    t = s.replace(',', '.');
  }
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Integer variant of numOrNull (floors may legitimately be negative). */
function smallInt(v, min, max) {
  const n = numOrNull(v, -Infinity, Infinity);
  if (n === null) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

function textOrNull(v, maxLen) {
  const s = String(v ?? '').trim();
  return s && s.length <= maxLen ? s : null;
}

function boolFromText(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (/^(da|yes|true|1)$/.test(s)) return true;
  if (/^(ne|no|false|0)$/.test(s)) return false;
  return null;
}

/** Opremljenost: fully furnished / unfurnished are clear; partial is not. */
function furnishedFromText(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (/^polu/.test(s)) return null;
  const b = boolFromText(s);
  if (b !== null) return b;
  if (s.includes('namje\u0161ten') || s.includes('namjesten')) {
    return s.includes('ne') ? false : true;
  }
  return null;
}

// ── characteristic codes → typed columns ─────────────────────────────────────

/**
 * attr_code → typed field mapping (codes observed on live olx.ba payloads;
 * raw pairs land in `characteristics` regardless, so an unknown/renamed code
 * stays recoverable from the DB).
 */
const CHAR_CODE_HANDLERS = {
  'broj-soba':            (v, o) => { o.roomsDetail = textOrNull(v, 40); },
  'broj-kupatila':        (v, o) => { o.bathrooms = smallInt(v, 0, 50); },
  'broj-etaza':           (v, o) => { o.unitLevels = smallInt(v, 1, 50); },
  'sprat':                (v, o) => { o.floorNum = smallInt(v, -5, 200); },
  'ukupno-spratova':      (v, o) => { o.floorsTotal = smallInt(v, 1, 200); },
  'grijanje':             (v, o) => { o.heating = textOrNull(v, 60); },
  'opremljenost':         (v, o) => { o.furnished = furnishedFromText(v); },
  'namjesten':            (v, o) => { if (o.furnished == null) o.furnished = boolFromText(v); },
  'stanje':               (v, o) => { o.condition = textOrNull(v, 60); },
  'parking':              (v, o) => { o.parking = boolFromText(v); },
  'garaza':               (v, o) => { o.garage = boolFromText(v); },
  'lift':                 (v, o) => { o.elevator = boolFromText(v); },
  'godina-izgradnje':     (v, o) => { o.yearBuilt = smallInt(v, 1800, 2100); },
  'okucnica-kvadratura':  (v, o) => { o.plotSqm = numOrNull(v, 1, 1000000); },
  'primarna-orjentacija': (v, o) => { o.orientation = textOrNull(v, 40); },
};

/** Node-side copy of extractArticleId() — cards still carry URLs. */
function extractArticleId(url) {
  const m = String(url || '').match(/\/artikal\/(\d+)/i);
  return m ? m[1] : null;
}

// ── shared bits ──────────────────────────────────────────────────────────────

const SELLER_TYPES = new Set(['shop', 'private']);

function specialLabelValue(item, label) {
  const hit = (Array.isArray(item.special_labels) ? item.special_labels : [])
    .find(l => l && l.label === label);
  return hit ? hit.value : null;
}

/** Coordinates only when plausible inside BiH. */
function pinOf(loc) {
  const lat = Number(loc && loc.lat), lon = Number(loc && loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inBiH(lat, lon)) {
    return { latitude: null, longitude: null };
  }
  return { latitude: lat, longitude: lon };
}

// ── search results ───────────────────────────────────────────────────────────

/**
 * One /api/search result object → card (db.saveCards contract) plus the
 * enrichment facts the search payload hands us for free.
 * Returns null for non-listing/empty entries.
 */
function parseSearchItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = Number(item.id);
  if (!Number.isFinite(id)) return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (title.length <= 2) return null;                 // same bar as the card parser

  const url = `https://olx.ba/artikal/${id}`;

  // price: 0 means "Na upit" (display_price says so explicitly).
  const priceNum = Number(item.price);
  const price = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;
  const displayPrice = typeof item.display_price === 'string'
    ? item.display_price.trim() : '';
  const priceText = displayPrice || (price === null ? 'Na upit' : String(price));

  let isRent = /rent|iznajm|najam/i.test(String(item.listing_type || ''));
  const isStudio = /garsonjera/i.test(title);

  // Sanity bounds identical to the HTML-card era.
  const sqm = numOrNull(specialLabelValue(item, 'Kvadrata'), 5, 500);

  let rooms = isStudio ? '0' : null;
  if (!isStudio) {
    const roomsRaw = specialLabelValue(item, 'Broj Soba');
    if (roomsRaw != null) {
      const s = String(roomsRaw);
      const pm = s.match(/\((\d+)\)/);                // "trosoban (3)"
      if (pm) rooms = pm[1];
      else if (/^\d+\+?$/.test(s.trim())) rooms = s.trim();
    }
  }

  // Backstop kept from the extension: implausibly cheap "sales" are rents.
  if (!isRent && price !== null && price < 3000) isRent = true;

  let ppm2 = (!isRent && price !== null && sqm > 0) ? Math.round(price / sqm) : null;
  if (ppm2 !== null && ppm2 > 15000) ppm2 = null;     // implausible parse

  return {
    articleId: id, title, url, sqm, rooms, price, priceText, ppm2, isRent,
    ...pinOf(item.location),
    publishedAt: Number.isFinite(Number(item.date))
      ? new Date(Number(item.date) * 1000) : null,
    sellerType: SELLER_TYPES.has(item.user_type) ? item.user_type : null,
    apiStatus: typeof item.status === 'string' ? item.status : null,
  };
}

/**
 * A validated /api/search payload → { cards, meta }.
 * Cards carry extra enrichment keys alongside the saveCards fields.
 */
function parseSearchPage(payload) {
  if (!payload || !Array.isArray(payload.data) ||
      !payload.meta || !Number.isFinite(Number(payload.meta.total))) {
    throw new Error('search payload lacks data[]/meta.total');
  }
  return {
    cards: payload.data.map(parseSearchItem).filter(Boolean),
    meta: {
      total: Number(payload.meta.total),
      lastPage: Number(payload.meta.last_page),
      currentPage: Number(payload.meta.current_page),
    },
  };
}

// ── ad detail (/api/listings/<id>) ───────────────────────────────────────────

/**
 * Full listing payload → one db.enrichListings() row (any field may be null).
 * created_at is the TRUE original publish time (date is the renewal bump);
 * first-wins SQL semantics make passing both safe.
 */
function parseListingDetail(json, fallbackId) {
  if (!json || typeof json !== 'object') return null;
  const articleId = Number.isFinite(Number(json.id)) ? Number(json.id)
                                                     : Number(fallbackId);
  if (!Number.isFinite(articleId)) return null;

  const detail = {
    articleId,
    ...pinOf(json.location),
    sqm: null,
    publishedAt: Number.isFinite(Number(json.created_at))
      ? new Date(Number(json.created_at) * 1000)
      : Number.isFinite(Number(json.date))
        ? new Date(Number(json.date) * 1000) : null,
    sellerType: json.user && SELLER_TYPES.has(json.user.type) ? json.user.type : null,
    roomsDetail: null, bathrooms: null, floorNum: null, floorsTotal: null,
    unitLevels: null, heating: null, furnished: null, condition: null,
    parking: null, garage: null, elevator: null, yearBuilt: null,
    plotSqm: null, orientation: null,
    views:     smallInt(json.views, 0, 100000000),
    favorites: smallInt(json.favorites, 0, 1000000),
    characteristics: {},
    apiStatus: typeof json.status === 'string' ? json.status : null,
    apiPriceHistory: Array.isArray(json.price_history)
      ? json.price_history
          .filter(p => p && Number.isFinite(Number(p.price)))
          .map(p => ({
            price: Number(p.price),
            date: Number.isFinite(Number(p.created_at)) ? Number(p.created_at) : null,
          }))
      : null,
  };

  for (const attr of Array.isArray(json.attributes) ? json.attributes : []) {
    const code = attr && attr.attr_code;
    if (!code || detail.characteristics[code] !== undefined) continue;
    const raw = attr.value;
    if (raw == null) continue;
    const trimmed = String(raw).trim();
    if (trimmed === '') continue;

    const numeric = /^-?\d+(?:\.\d+)?$/.test(cleanNumberString(trimmed));
    detail.characteristics[code] =
      numeric ? numOrNull(trimmed, -Infinity, Infinity) : trimmed;

    const handler = CHAR_CODE_HANDLERS[code];
    if (handler) handler(trimmed, detail);
  }

  // kvadrata is stored raw above AND feeds the typed sqm column (same 5–500
  // sanity bounds as the search-card path).
  if (detail.characteristics['kvadrata'] != null) {
    const v = numOrNull(detail.characteristics['kvadrata'], 5, 500);
    if (v !== null) detail.sqm = v;
  }

  return detail;
}

module.exports = {
  extractArticleId, parseSearchItem, parseSearchPage, parseListingDetail,
  inBiH, numOrNull, CHAR_CODE_HANDLERS, BIH_BBOX,
};


