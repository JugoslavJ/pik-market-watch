'use strict';
// Parser: collectCardsInPage runs INSIDE the olx.ba page via page.evaluate().
//
// The logic is a 1:1 port of the original browser extension's parser
// (parseNumber / CardParser.parseCard / CardParser.collectAllCards —
// preserved in git history) so results match what the panel showed.

async function collectCards(page) {
  return page.evaluate(collectCardsInPage);
}

function collectCardsInPage() {
  function parseNumber(rawString) {
    if (!rawString) return null;
    let s = rawString.replace(/\s/g, '');
    const hasComma = s.includes(','), hasDot = s.includes('.');
    if (hasComma && hasDot) {
      if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
      else s = s.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) {
      s = s.replace(',', '.');
    } else if (hasDot && s.split('.').pop().length === 3) {
      s = s.replace(/\./g, '');
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function parseCard(el) {
    const title = el.querySelector('.main-heading')?.textContent.trim() || '';
    const url   = (el.closest('a') || el.querySelector('a'))?.href || '';
    const textContent = el.textContent || '';

    let isRent = /Iznajmljivanje/i.test(textContent) || /najam/i.test(textContent);
    const isStudio = /garsonjera/i.test(textContent);

    let sqm = null, rooms = isStudio ? '0' : null;
    for (const tag of el.querySelectorAll('.standard-tag')) {
      const text = tag.textContent;
      const val  = (tag.querySelector('div')?.textContent || '').trim();
      if (text.includes('\u33A1') || text.includes('m\u00B2')) {
        sqm = parseNumber(val);
      } else if (!isStudio) {
        const pm = text.match(/\((\d+)\)/);
        if (pm) rooms = pm[1];
        else if (/^\d+\+?$/.test(val)) rooms = val;
      }
    }

    const priceEl = el.querySelector('.price-wrap .smaller');
    let price = null, priceText = 'Na upit';
    if (priceEl) {
      priceText = priceEl.textContent.trim();
      if (!/na upit/i.test(priceText)) {
        const m = priceText.match(/([\d.,\s]+)/);
        if (m) price = parseNumber(m[1]);
      }
    }

    // Sanity bounds (same rationale as the extension):
    if (sqm !== null && (sqm < 5 || sqm > 500)) sqm = null;   // plots parsed as apartments
    if (!isRent && price !== null && price < 3000) isRent = true;

    let ppm2 = (!isRent && price && sqm > 0) ? Math.round(price / sqm) : null;
    if (ppm2 !== null && ppm2 > 15000) ppm2 = null;           // implausible parse

    return { title, url, sqm, rooms, price, priceText, ppm2, isRent };
  }

  return Array.from(document.querySelectorAll('.content-wrap'))
    .map(parseCard)
    .filter(d => d.title.length > 2);
}

/** Node-side copy of extractArticleId() from shared/utils.js. */
function extractArticleId(url) {
  const m = String(url || '').match(/\/artikal\/(\d+)/i);
  return m ? m[1] : null;
}

// ── Ad DETAIL pages ───────────────────────────────────────────────────────────
// Strategy: fetch the page HTML once after hydration (page.evaluate can only
// serialize plain data), then parse everything in Node so the regexes live in
// exactly one place and are unit-testable.
//
// Map pin: olx.ba embeds the ad's coordinates in its Nuxt state as a literal,
//   location:{lat:44.825690864477,lon:17.302538236771}
// A quoted template default ({"lat":"43.1235","lon":"42.5426"}) also exists on
// every page and MUST be discarded — the Bosnia bounding box below does that.
//
// Floor area: characteristics are structured Nuxt attributes, e.g.
//   {id:…,type:…,value:72,attr_code:"kvadrata",name:"Kvadrata"}
// Search cards carry no m² tag for some categories (vikendice), so this is the
// only reliable source. Plot size ("okucnica-kvadratura") is a separate code
// and never matched here.
//
// Everything else (characteristics, publish/renewal date, seller type, view
// and favorite counters) comes from the SAME hydrated HTML via two channels:
//   - the attr_code objects above: one generic pattern captures every code,
//     known codes get typed columns, ALL codes land in `characteristics`
//   - rendered DOM text: "Pregledi: 6331", "Obnovljen: 21.08.2026 u 15:09",
//     "PIK Shop"/"PIK Partner" seller badges, … (verified on live ad pages)

async function fetchDetailHtml(page) {
  return page.evaluate(() => document.documentElement.outerHTML);
}

const BIH_BBOX = { latMin: 42.4, latMax: 46.4, lonMin: 15.5, lonMax: 19.9 };

const PIN_PATTERNS = [
  /location:\{lat:(-?\d{1,2}\.\d{3,}),lon:(-?\d{1,3}\.\d{3,})\}/g,          // Nuxt state literal
  /"lat":\s*"?(-?\d{1,2}\.\d{3,})"?\s*,\s*"lon":\s*"?(-?\d{1,3}\.\d{3,})"?/g // JSON fallback
];

const KVADRATA_PATTERN =
  /\{id:\d+,type:[A-Za-z0-9_$]+,value:(\d{1,4}(?:\.\d+)?),attr_code:"kvadrata"/;

// Every characteristic object on the page, regardless of its code. Object
// bodies contain no nested braces in the Nuxt literal format.
const ATTR_OBJECT_PATTERN = /\{[^{}]*?attr_code:"([A-Za-z0-9_-]+)"[^{}]*?\}/g;
const ATTR_VALUE_PATTERN  = /(?:^|[,{])value:(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^,}]+))/;

// Page-level (non-characteristic) facts, all verified against live ad pages.
const PUBLISHED_PATTERN  = /Objavljen:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\.?(?:\s+u\s+(\d{1,2}):(\d{2}))?/i;
const RENEWED_PATTERN    = /Obnovljen:\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\.?(?:\s+u\s+(\d{1,2}):(\d{2}))?/i;
const VIEWS_PATTERNS     = [/Pregledi:\s*([\d.,]+)/i, /"views?":\s*"?(\d+)"?/i];
const FAVORITES_PATTERNS = [
  /"favorites":\s*"?(\d+)"?/i,
  /"savedCount":\s*"?(\d+)"?/i,
  /Spasi oglas\s*\((\d{1,6})\)/i,
];
const SHOP_BADGE_PATTERN     = /PIK\s+(?:Shop|Partner)/i;   // agency / PIK Shop seller
const PRIVATE_SELLER_PATTERN = /Prosje\u010dno vrijeme odgovora|Korisnik je verifikovao/i;

// ── value coercion helpers (Node side, unit-tested) ──────────────────────────

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

/** "dd.mm.yyyy [u HH:MM]" → Date (day precision is what matters; noon UTC). */
function bihDateToIso(d, m, y, hh, mm) {
  const day = parseInt(d, 10), mon = parseInt(m, 10), year = parseInt(y, 10);
  if (!(day >= 1 && day <= 31 && mon >= 1 && mon <= 12 && year >= 2000 && year <= 2100)) {
    return null;
  }
  return new Date(Date.UTC(year, mon - 1, day, hh ? parseInt(hh, 10) : 12, mm ? parseInt(mm, 10) : 0));
}

function matchDate(pattern, html) {
  const m = html.match(pattern);
  return m ? bihDateToIso(m[1], m[2], m[3], m[4], m[5]) : null;
}

function matchInt(patterns, html, min, max) {
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
  }
  return null;
}

/**
 * attr_code → typed field mapping. Codes observed on live olx.ba pages; the
 * raw pairs land in `characteristics` regardless, so a renamed/unknown code
 * is recoverable from the DB even when no handler matches.
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

function inBiH(lat, lon) {
  return lat >= BIH_BBOX.latMin && lat <= BIH_BBOX.latMax &&
         lon >= BIH_BBOX.lonMin && lon <= BIH_BBOX.lonMax;
}

/**
 * Parse an ad detail page's HTML → detail facts (any field may be null):
 * pin + area as before, plus publish date, seller type, counters, typed
 * characteristics and a raw attr_code:value map.
 */
function parseDetail(html) {
  let latitude = null, longitude = null;
  for (const re of PIN_PATTERNS) {
    for (const m of html.matchAll(re)) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (inBiH(lat, lon)) { latitude = lat; longitude = lon; break; }
    }
    if (latitude !== null) break;
  }

  let sqm = null;
  const km = html.match(KVADRATA_PATTERN);
  if (km) {
    const v = parseFloat(km[1]);
    if (v >= 5 && v <= 500) sqm = v;   // same sanity bounds as the card parser
  }

  const detail = {
    latitude, longitude, sqm,
    // "Objavljen" is the real publish date when present; "Obnovljen" is the
    // renewal stamp most ads only show — better than nothing for days-on-market.
    publishedAt: matchDate(PUBLISHED_PATTERN, html)
              ?? matchDate(RENEWED_PATTERN, html),
    sellerType: SHOP_BADGE_PATTERN.test(html) ? 'shop'
              : PRIVATE_SELLER_PATTERN.test(html) ? 'private' : null,
    roomsDetail: null, bathrooms: null, floorNum: null, floorsTotal: null,
    unitLevels: null, heating: null, furnished: null, condition: null,
    parking: null, garage: null, elevator: null, yearBuilt: null,
    plotSqm: null, orientation: null,
    views:     matchInt(VIEWS_PATTERNS, html, 0, 100000000),
    favorites: matchInt(FAVORITES_PATTERNS, html, 0, 1000000),
    characteristics: {},
  };

  // Every attr_code object on the page: typed column where we know the code,
  // raw pair into `characteristics` always. First sighting wins — pages can
  // repeat an attribute in several state blobs.
  for (const m of html.matchAll(ATTR_OBJECT_PATTERN)) {
    const code = m[1];
    if (detail.characteristics[code] !== undefined) continue;
    const vm = m[0].match(ATTR_VALUE_PATTERN);
    if (!vm) continue;
    const raw = vm[1] ?? vm[2] ?? vm[3];
    if (raw == null) continue;
    const trimmed = raw.trim().replace(/\\(.)/g, '$1');
    if (trimmed === '') continue;

    const numeric = /^-?\d+(?:\.\d+)?$/.test(cleanNumberString(trimmed));
    detail.characteristics[code] =
      numeric ? numOrNull(trimmed, -Infinity, Infinity) : trimmed;

    const handler = CHAR_CODE_HANDLERS[code];
    if (handler) handler(trimmed, detail);
  }

  return detail;
}

async function extractGeo(page) {
  return parseDetail(await fetchDetailHtml(page));
}

module.exports = { collectCards, extractArticleId, extractGeo, parseDetail };

