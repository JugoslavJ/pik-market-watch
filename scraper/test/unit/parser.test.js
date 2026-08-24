'use strict';
// Unit tests for parser.js — pure mapping of olx.ba JSON payloads.
// Fixture-backed where possible (test/fixtures/, refreshed via `npm run
// fixtures`) so payload drift breaks CI instead of production; synthetic
// cases cover the nasty edges seen in the wild.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractArticleId, parseSearchItem, parseSearchPage, parseListingDetail,
} = require('../../src/parser');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const load = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

let searchPage = null, listing = null;
try {
  searchPage = load('api-search-page1.json');
  listing = load('api-listing-detail.json');
} catch (_) { /* bare checkout without fixtures — synthetic tests still run */ }
const withFixtures = (searchPage && listing) ? test : test.skip;

// ── recorded payloads ────────────────────────────────────────────────────────

withFixtures('parseSearchPage: recorded Stanovi-BL page keeps meta + cards', () => {
  const { cards, meta } = parseSearchPage(searchPage);
  assert.equal(meta.total, 989);
  assert.equal(meta.lastPage, 25);
  assert.ok(cards.length >= 30);
  for (const c of cards) {
    assert.ok(/\/artikal\/\d+$/.test(c.url));
    assert.ok(Number.isFinite(c.articleId));
  }
});

// ── synthetic edges (shapes verified against live payloads) ──────────────────

test('search item: priced sale maps price/m²/rooms/ppm²/pin/seller', () => {
  const card = parseSearchItem({
    id: 78615352, title: 'Prodaja/ stan/ Sarajevo/ Centar/ dvosoban/ 58 m2',
    price: 435000, display_price: '435.000 KM', listing_type: 'sell',
    special_labels: [
      { value: 58, label: 'Kvadrata', unit: '㎡' },
      { value: 'dvosoban (2)', label: 'Broj Soba', unit: null },
    ],
    location: { lat: 43.8573271, lon: 18.4035739 },
    date: 1787531183, user_type: 'shop', status: 'active',
  });
  assert.deepEqual(
    { title: card.title, url: card.url, sqm: card.sqm, rooms: card.rooms,
      price: card.price, priceText: card.priceText, ppm2: card.ppm2,
      isRent: card.isRent }, {
      title: 'Prodaja/ stan/ Sarajevo/ Centar/ dvosoban/ 58 m2',
      url: 'https://olx.ba/artikal/78615352',
      sqm: 58, rooms: '2', price: 435000,
      priceText: '435.000 KM', ppm2: 7500, isRent: false });
  assert.equal(card.sellerType, 'shop');
  assert.equal(card.apiStatus, 'active');
  assert.equal(card.latitude, 43.8573271);
  assert.equal(card.longitude, 18.4035739);
});

test('search item: "Na upit" (price 0) stays unpriced, ppm² null, no pin', () => {
  const card = parseSearchItem({
    id: 78191965, title: 'ODMAH USELJIV - trosoban stan 59m2',
    price: 0, display_price: 'Na upit', listing_type: 'sell',
    special_labels: [{ value: 59, label: 'Kvadrata' }],
    location: null, user_type: 'shop',
  });
  assert.equal(card.price, null);
  assert.equal(card.priceText, 'Na upit');
  assert.equal(card.ppm2, null);
  assert.equal(card.latitude, null);
});

test('search item: listing_type rent wins; rents never get KM/m²', () => {
  const card = parseSearchItem({ id: 9, title: 'Stan iznajmljivanje 60m2',
    price: 600, display_price: '600 KM', listing_type: 'rent',
    special_labels: [{ value: 60, label: 'Kvadrata' }] });
  assert.equal(card.isRent, true);
  assert.equal(card.ppm2, null);
});


test('search item: cheap "sale" falls back to rent', () => {
  const card = parseSearchItem({ id: 10, title: 'garsonjera prizemlje',
    price: 250, display_price: '250 KM', listing_type: 'sell',
    special_labels: [] });
  assert.equal(card.isRent, true);
  assert.equal(card.rooms, '0');              // garsonjera counts as studio
});

test('search item: garbage m² (a real live case: value 4) discarded', () => {
  const card = parseSearchItem({ id: 11, title: 'Dvosoban stan test',
    price: 50000, listing_type: 'sell',
    special_labels: [{ value: 4, label: 'Kvadrata' },
                     { value: 'dvosoban (2)', label: 'Broj Soba' }] });
  assert.equal(card.sqm, null);
  assert.equal(card.rooms, '2');
  assert.equal(card.ppm2, null);
});

test('search item: implausible KM/m² (>15000) nulled; foreign pin rejected', () => {
  const card = parseSearchItem({ id: 12, title: 'Mikro stan centar',
    price: 400000, listing_type: 'sell',
    special_labels: [{ value: 20, label: 'Kvadrata' }],
    location: { lat: 51.5074, lon: -0.1278 } });       // London
  assert.equal(card.ppm2, null);                      // 20000 → nulled
  assert.equal(card.latitude, null);
  assert.equal(card.longitude, null);
});

test('search item: junk entries → null', () => {
  assert.equal(parseSearchItem(null), null);
  assert.equal(parseSearchItem({}), null);
  assert.equal(parseSearchItem({ id: 13, title: 'ab' }), null);
});

test('detail: attributes[] feed typed columns and characteristics', () => {
  const d = parseListingDetail({
    id: 69441462,
    created_at: 1752875036,
    date: 1787527805,
    status: 'active',
    views: 37194,
    favorites: 41,
    user: { type: 'shop' },
    location: { lat: 44.76995369956578, lon: 17.189762566017492 },
    price_history: [
      { price: 246000, created_at: 1782389022 },
      { price: 236000, created_at: 1767000377 },
    ],
    attributes: [
      { attr_code: 'stanje', value: 'Novogradnja' },
      { attr_code: 'kvadrata', value: 38 },
      { attr_code: 'sprat', value: '1' },
      { attr_code: 'parking', value: 'Da' },
      { attr_code: 'exotic-unknown-code', value: 'kept-raw' },
    ],
  });
  assert.equal(d.articleId, 69441462);
  assert.equal(d.condition, 'Novogradnja');           // attr_code 'stanje'
  assert.equal(d.sqm, 38);
  assert.equal(d.floorNum, 1);
  assert.equal(d.parking, true);
  assert.equal(d.views, 37194);
  assert.equal(d.favorites, 41);
  assert.equal(d.sellerType, 'shop');
  assert.equal(d.apiStatus, 'active');
  assert.deepEqual(d.publishedAt, new Date(1752875036 * 1000));  // created_at wins
  assert.equal(d.characteristics['exotic-unknown-code'], 'kept-raw');
  assert.equal(d.apiPriceHistory.length, 2);
  assert.deepEqual(d.apiPriceHistory[0],
    { price: 246000, date: 1782389022 });
});

test('detail: empty/garbage payload tolerated', () => {
  assert.equal(parseListingDetail(null), null);
  const d = parseListingDetail({ id: 42 });
  assert.equal(d.articleId, 42);
  assert.equal(d.sqm, null);
  assert.deepEqual(d.characteristics, {});
  assert.equal(d.apiPriceHistory, null);
});

// ── extractArticleId (unchanged contract) ────────────────────────────────────

test('extractArticleId: standard /artikal/<id>/ URLs', () => {
  assert.equal(extractArticleId('https://olx.ba/artikal/74558628'), '74558628');
  assert.equal(extractArticleId('https://www.olx.ba/artikal/123456/'), '123456');
  assert.equal(extractArticleId('https://olx.ba/artikal/99?some=qs'), '99');
});

test('extractArticleId: non-matching URLs → null', () => {
  assert.equal(extractArticleId('https://olx.ba/pretraga?kat=16'), null);
  assert.equal(extractArticleId(''), null);
  assert.equal(extractArticleId(undefined), null);
});
