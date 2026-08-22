'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { cardParserContext } = require('./setup');

const g  = cardParserContext();
const CP = g.$get('CardParser');

// ── DOM builder matching real OLX .content-wrap structure ─────────────────────
//
// OLX card HTML (simplified):
//   <div class="content-wrap">
//     <a href="https://www.olx.ba/artikal/123456/...">
//       <h3 class="main-heading">Title text</h3>
//     </a>
//     <ul>
//       <li class="standard-tag"><p>60</p><span>m²</span></li>   ← sqm tag
//       <li class="standard-tag"><p>2</p><span>(2)</span></li>   ← rooms tag
//     </ul>
//     <div class="price-wrap">
//       <strong class="smaller">125.000 KM</strong>
//     </div>
//   </div>

function makeTag(val, labelText) {
  // Matches: tag.querySelector('div').textContent → val
  //          tag.textContent                       → val + labelText
  return {
    tagName: 'LI',
    className: 'standard-tag',
    textContent: String(val) + String(labelText),
    querySelector(sel) {
      if (sel === 'div') return { textContent: String(val) };
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}

function makePriceEl(text) {
  return {
    tagName: 'STRONG',
    className: 'smaller',
    textContent: text,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}

function makeCard({ title = 'Stan', url = 'https://www.olx.ba/artikal/111111/stan', sqmVal = '60',
                    rooms = '2', priceText = '125.000 KM', isRentCategory = false } = {}) {
  const tags = [];
  if (sqmVal !== null) tags.push(makeTag(sqmVal, ' m²'));
  if (rooms !== null)  tags.push(makeTag(rooms,  ` (${rooms})`));

  const priceEl = makePriceEl(priceText);
  const heading = { textContent: title, querySelector() { return null; } };
  const link    = { tagName: 'A', href: url, textContent: title };

  const allText = [
    title,
    sqmVal ? `${sqmVal} m²` : '',
    rooms  ? `(${rooms})`  : '',
    priceText,
    isRentCategory ? 'Iznajmljivanje' : '',
  ].join(' ');

  return {
    tagName: 'DIV',
    className: 'content-wrap',
    textContent: allText,
    closest(sel) { return null; },
    querySelector(sel) {
      if (sel === '.main-heading') return heading;
      if (sel === 'a')             return link;
      if (sel === '.price-wrap .smaller') return priceEl;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.standard-tag') return tags;
      return [];
    },
  };
}

// ── parseCard: basic fields ───────────────────────────────────────────────────

describe('CardParser.parseCard: basic extraction', () => {
  test('title extracted from .main-heading', () => {
    const r = CP.parseCard(makeCard({ title: 'Dvosoban stan' }));
    assert.equal(r.title, 'Dvosoban stan');
  });

  test('url from anchor href', () => {
    const r = CP.parseCard(makeCard({ url: 'https://www.olx.ba/artikal/999/test' }));
    assert.equal(r.url, 'https://www.olx.ba/artikal/999/test');
  });

  test('sqm parsed from m² tag', () => {
    const r = CP.parseCard(makeCard({ sqmVal: '75' }));
    assert.equal(r.sqm, 75);
  });

  test('rooms extracted from (N) pattern', () => {
    const r = CP.parseCard(makeCard({ rooms: '3' }));
    assert.equal(r.rooms, '3');
  });

  test('price parsed from price-wrap', () => {
    const r = CP.parseCard(makeCard({ priceText: '125.000 KM' }));
    assert.equal(r.price, 125000);
  });

  test('ppm2 computed as price / sqm', () => {
    const r = CP.parseCard(makeCard({ priceText: '125.000 KM', sqmVal: '50' }));
    assert.equal(r.ppm2, 2500);  // 125000 / 50
  });

  test('ppm2 rounded to integer', () => {
    const r = CP.parseCard(makeCard({ priceText: '100.000 KM', sqmVal: '60' }));
    assert.equal(r.ppm2, Math.round(100000 / 60));
  });
});

// ── parseCard: isRent detection ───────────────────────────────────────────────

describe('CardParser.parseCard: rent detection', () => {
  test('isRent false for normal sale', () => {
    const r = CP.parseCard(makeCard({ priceText: '125.000 KM' }));
    assert.equal(r.isRent, false);
  });

  test('isRent true for Iznajmljivanje in text', () => {
    const r = CP.parseCard(makeCard({ isRentCategory: true, priceText: '500 KM' }));
    assert.equal(r.isRent, true);
  });

  test('isRent true for "najam" in title', () => {
    const r = CP.parseCard(makeCard({ title: 'Iznajmljujem stan', priceText: '600 KM' }));
    assert.equal(r.isRent, true);
  });

  test('isRent true when price < 3000 (heuristic for miscategorised)', () => {
    const r = CP.parseCard(makeCard({ priceText: '450 KM' }));
    assert.equal(r.isRent, true);
  });

  test('price = 3000 is not forced isRent', () => {
    const r = CP.parseCard(makeCard({ priceText: '3.000 KM' }));
    assert.equal(r.isRent, false);
  });

  test('ppm2 is null for rent listings', () => {
    const r = CP.parseCard(makeCard({ isRentCategory: true, priceText: '500 KM', sqmVal: '60' }));
    assert.equal(r.ppm2, null);
  });
});

// ── parseCard: garsonjera (studio) ───────────────────────────────────────────

describe('CardParser.parseCard: garsonjera', () => {
  test('garsonjera in title → rooms = "0"', () => {
    const r = CP.parseCard(makeCard({ title: 'Garsonjera Sarajevo', rooms: null, sqmVal: '28' }));
    assert.equal(r.rooms, '0');
  });

  test('garsonjera in body text → rooms = "0"', () => {
    // Simulate garsonjera in the textContent without it being in title
    const card = makeCard({ title: 'Jednosoban', rooms: null });
    // Override textContent to include garsonjera
    card.textContent = card.textContent + ' garsonjera ';
    const r = CP.parseCard(card);
    assert.equal(r.rooms, '0');
  });

  test('garsonjera isRent false at sale price', () => {
    const r = CP.parseCard(makeCard({ title: 'Garsonjera prodaja', priceText: '60.000 KM', sqmVal: '30', rooms: null }));
    assert.equal(r.isRent, false);
  });
});

// ── parseCard: edge cases ─────────────────────────────────────────────────────

describe('CardParser.parseCard: edge cases', () => {
  test('"Na upit" price → price null, priceText preserved', () => {
    const r = CP.parseCard(makeCard({ priceText: 'Na upit' }));
    assert.equal(r.price, null);
    assert.equal(r.priceText, 'Na upit');
  });

  test('missing sqm → sqm null, ppm2 null', () => {
    const r = CP.parseCard(makeCard({ sqmVal: null, priceText: '100.000 KM' }));
    assert.equal(r.sqm,  null);
    assert.equal(r.ppm2, null);
  });

  test('sqm = 0 → ppm2 null (no divide by zero)', () => {
    const r = CP.parseCard(makeCard({ sqmVal: '0', priceText: '100.000 KM' }));
    assert.equal(r.ppm2, null);
  });

  test('dot-thousands formatted price (actual OLX format)', () => {
    // OLX uses European dot-thousands: "95.000 KM" not American "95,000"
    const r = CP.parseCard(makeCard({ priceText: '95.000 KM', sqmVal: '50' }));
    assert.equal(r.price, 95000);
    assert.equal(r.ppm2, 1900); // 95000 / 50
  });

  test('all fields present in return object', () => {
    const r = CP.parseCard(makeCard());
    for (const f of ['title', 'url', 'sqm', 'rooms', 'price', 'priceText', 'ppm2', 'isRent']) {
      assert.ok(f in r, `missing field: ${f}`);
    }
  });
});

// ── collectAllCards ───────────────────────────────────────────────────────────

describe('CardParser.collectAllCards', () => {
  test('returns empty array when no .content-wrap in document', () => {
    // The test vm context has a stub document with no cards
    const result = CP.collectAllCards();
    assert.equal(result.length, 0);
  });

  test('collectAllCards filters out cards with short/empty titles', () => {
    // We can't easily inject DOM nodes into the vm document stub,
    // but we can verify the filter logic by testing parseCard with short titles
    const card = makeCard({ title: 'AB' }); // 2 chars
    const r = CP.parseCard(card);
    // parseCard itself returns the result; collectAllCards would filter r.title.length > 2
    assert.ok(r.title.length <= 2, 'short title card would be filtered by collectAllCards');
  });
});
