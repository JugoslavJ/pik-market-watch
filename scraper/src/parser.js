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

// ── Ad DETAIL pages: map pin + floor area ─────────────────────────────────────
// Strategy: fetch the page HTML once (page.evaluate can only serialize plain
// data), then parse everything in Node so the regexes live in exactly one
// place and are unit-testable.
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

function inBiH(lat, lon) {
  return lat >= BIH_BBOX.latMin && lat <= BIH_BBOX.latMax &&
         lon >= BIH_BBOX.lonMin && lon <= BIH_BBOX.lonMax;
}

/** Parse an ad detail page's HTML → { latitude, longitude, sqm } (any may be null). */
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
  return { latitude, longitude, sqm };
}

async function extractGeo(page) {
  return parseDetail(await fetchDetailHtml(page));
}

module.exports = { collectCards, extractArticleId, extractGeo, parseDetail };

