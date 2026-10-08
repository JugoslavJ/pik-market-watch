"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  mapSearchItem,
  mapSearchItems,
  mapSearchPage,
  mapListingDetail,
} = require("../../src/payload-mapper");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

const searchPage = load("api-search-page1.json");

// recorded payloads
test("mapSearchPage: recorded Stanovi-BL page keeps meta + cards", () => {
  const { cards, meta } = mapSearchPage(searchPage);
  assert.equal(meta.total, 989);
  assert.equal(meta.lastPage, 25);
  assert.ok(cards.length >= 30);
  for (const c of cards) {
    assert.ok(/\/artikal\/\d+$/.test(c.url));
    assert.ok(Number.isFinite(c.articleId));
  }
});

// synthetic edges (shapes verified against live payloads)
test("search item: priced sale maps price/m²/rooms/pin/seller", () => {
  const card = mapSearchItem({
    id: 78615352,
    title: "Prodaja/ stan/ Sarajevo/ Centar/ dvosoban/ 58 m2",
    price: 435000,
    display_price: "435.000 KM",
    listing_type: "sell",
    special_labels: [
      { value: 58, label: "Kvadrata", unit: "㎡" },
      { value: "dvosoban (2)", label: "Broj Soba", unit: null },
    ],
    location: { lat: 43.8573271, lon: 18.4035739 },
    date: 1787531183,
    user_type: "shop",
    status: "active",
  });
  assert.deepEqual(
    {
      title: card.title,
      url: card.url,
      sqm: card.sqm,
      rooms: card.rooms,
      price: card.price,
      priceText: card.priceText,
      isRent: card.isRent,
    },
    {
      title: "Prodaja/ stan/ Sarajevo/ Centar/ dvosoban/ 58 m2",
      url: "https://olx.ba/artikal/78615352",
      sqm: 58,
      rooms: "2",
      price: 435000,
      priceText: "435.000 KM",
      isRent: false,
    },
  );
  assert.equal(card.sellerType, "shop");
  assert.equal(card.apiStatus, "active");
  assert.equal(card.latitude, 43.8573271);
  assert.equal(card.longitude, 18.4035739);
  // Search cards carry only the renewal stamp — it must land on renewedAt,
  // never be passed off as the creation date:
  assert.deepEqual(card.renewedAt, new Date(1787531183 * 1000));
  assert.equal(card.publishedAt, undefined);
});

test('search item: "Na upit" (price 0) stays unpriced, no pin', () => {
  const card = mapSearchItem({
    id: 78191965,
    title: "ODMAH USELJIV - trosoban stan 59m2",
    price: 0,
    display_price: "Na upit",
    listing_type: "sell",
    special_labels: [{ value: 59, label: "Kvadrata" }],
    location: null,
    user_type: "shop",
  });
  assert.equal(card.price, null);
  assert.equal(card.priceText, "Na upit");
  assert.equal(card.ppm2, undefined);
  assert.equal(card.latitude, null);
});

test("search item: listing_type rent wins", () => {
  const card = mapSearchItem({
    id: 9,
    title: "Stan iznajmljivanje 60m2",
    price: 600,
    display_price: "600 KM",
    listing_type: "rent",
    special_labels: [{ value: 60, label: "Kvadrata" }],
  });
  assert.equal(card.isRent, true);
  assert.equal(card.ppm2, undefined);
});

test("search item: OLX category sets the property type", () => {
  const card = mapSearchItem({
    id: 11,
    title: "Kuća na prodaju 140m2",
    price: 250000,
    listing_type: "sell",
    category_id: 24,
  });
  assert.equal(card.categoryId, 24);
  assert.equal(card.propertyType, "houses");
  assert.equal(card.dealType, "sale");
  assert.equal(
    mapSearchItem({ id: 12, title: "bez kategorije" }).propertyType,
    null,
  );
});

test("search item: daily rentals posted as sales keep their nightly price", () => {
  // A real live case: Stan na dan cards arrive as listing_type "sell".
  const card = mapSearchItem({
    id: 23111687,
    title: "Stan na dan centar",
    price: 40,
    display_price: "40 KM",
    listing_type: "sell",
    category_id: 2668,
  });
  assert.equal(card.dealType, "daily_rent");
  assert.equal(card.isRent, false);
  assert.equal(card.propertyType, "daily_rent");
  assert.equal(card.price, 40);
  assert.equal(card.priceState, "valid");
});

test("search item: rents posted as sales become rentals", () => {
  // Real live case: an office for rent, posted as a sale at 450 KM.
  const card = mapSearchItem({
    id: 13,
    title: "Iznajmljujemo poslovni prostor 20m2 u centru grada",
    price: 450,
    display_price: "450 KM",
    listing_type: "sell",
    category_id: 25,
    special_labels: [{ value: 20, label: "Kvadrata" }],
  });
  assert.equal(card.dealType, "rent");
  assert.equal(card.isRent, true);
  assert.equal(card.price, 450);
  assert.equal(card.priceBasis, "total");
});

test("search item: land priced per m² keeps a total sale price", () => {
  // Real live case: "ZEMLJIŠTE 7500 m2 ... 40 KM po m2".
  const card = mapSearchItem({
    id: 14,
    title: "ZEMLJIŠTE 7500 m2, BUKVALEK, 40 KM po m2",
    price: 40,
    display_price: "40 KM",
    listing_type: "sell",
    category_id: 29,
    special_labels: [{ value: "7.500", label: "Kvadrata" }],
  });
  assert.equal(card.sqm, 7500);
  assert.equal(card.dealType, "sale");
  assert.equal(card.price, 300000);
  assert.equal(card.priceBasis, "per_sqm");
  assert.equal(card.priceText, "40 KM");
});

test("search item: sale price boundary preserves deal and missing-area behavior", () => {
  for (const price of [250, "2.999"]) {
    const card = mapSearchItem({
      id: "10",
      title: "garsonjera prizemlje",
      price,
      listing_type: "sell",
      special_labels: [],
    });
    assert.equal(card.isRent, false);
    assert.equal(card.dealType, "sale");
    assert.equal(card.price, null);
    assert.equal(card.priceState, "invalid");
    assert.equal(card.priceReason, "below_sale_minimum");
    assert.equal(card.rooms, "0"); // garsonjera counts as studio
  }

  const validNoArea = mapSearchItem({
    id: 102,
    title: "sale with unknown area",
    listing_type: "sell",
    price: "3.000",
  });
  assert.equal(validNoArea.priceState, "valid");
  assert.equal(validNoArea.price, 3000);
  assert.equal(validNoArea.ppm2, undefined);
});

test("search item: garbage m² (a real live case: value 4) discarded", () => {
  const card = mapSearchItem({
    id: 11,
    title: "Dvosoban stan test",
    price: 50000,
    listing_type: "sell",
    special_labels: [
      { value: 4, label: "Kvadrata" },
      { value: "dvosoban (2)", label: "Broj Soba" },
    ],
  });
  assert.equal(card.sqm, null);
  assert.equal(card.rooms, "2");
  assert.equal(card.ppm2, undefined);
});

test("search item: foreign pin rejected", () => {
  const card = mapSearchItem({
    id: 12,
    title: "Mikro stan centar",
    price: 400000,
    listing_type: "sell",
    special_labels: [{ value: 20, label: "Kvadrata" }],
    location: { lat: 51.5074, lon: -0.1278 },
  }); // London
  assert.equal(card.ppm2, undefined);
  assert.equal(card.latitude, null);
  assert.equal(card.longitude, null);
});

test("search item: junk entries → null", () => {
  assert.equal(mapSearchItem(null), null);
  assert.equal(mapSearchItem({}), null);
  assert.equal(mapSearchItem({ id: 13, title: "ab" }), null);
});

test("search items: mapping diagnostics distinguish rejected entries", () => {
  const result = mapSearchItems([
    { id: 13, title: "ab" },
    { id: 14, title: "Valid listing" },
    null,
  ]);
  assert.equal(result.cards.length, 1);
  assert.deepEqual(
    result.rejected.map((entry) => entry.reason),
    ["invalid_title", "not_an_object"],
  );
});

test("detail: attributes[] feed typed columns and characteristics", () => {
  const d = mapListingDetail({
    id: 69441462,
    created_at: 1752875036,
    date: 1787527805,
    status: "active",
    views: 37194,
    favorites: 41,
    user: { type: "shop" },
    location: { lat: 44.76995369956578, lon: 17.189762566017492 },
    price_history: [
      { price: 246000, created_at: 1782389022 },
      { price: 236000, created_at: 1767000377 },
    ],
    attributes: [
      { attr_code: "stanje", value: "Novogradnja" },
      { attr_code: "kvadrata", value: 38 },
      { attr_code: "sprat", value: "1" },
      { attr_code: "parking", value: "Da" },
      { attr_code: "exotic-unknown-code", value: "kept-raw" },
    ],
  });
  assert.equal(d.articleId, 69441462);
  assert.equal(d.condition, "Novogradnja"); // attr_code 'stanje'
  assert.equal(d.sqm, 38);
  assert.equal(d.floorNum, 1);
  assert.equal(d.parking, true);
  assert.equal(d.views, 37194);
  assert.equal(d.favorites, 41);
  assert.equal(d.sellerType, "shop");
  assert.equal(d.apiStatus, "active");
  assert.deepEqual(d.publishedAt, new Date(1752875036 * 1000)); // created_at wins
  assert.deepEqual(d.renewedAt, new Date(1787527805 * 1000)); // date = renewal bump
  assert.equal(d.characteristics["exotic-unknown-code"], "kept-raw");
  assert.equal(d.apiPriceHistory.length, 2);
  assert.deepEqual(d.apiPriceHistory[0], { price: 236000, date: 1767000377 });
});

test("detail: localized values map while raw history retains rejected duplicates", () => {
  const before = Math.floor(Date.parse("2026-09-05T12:00:00Z") / 1000) - 100;
  const rawHistory = [
    { price: 3000, created_at: before },
    { price: 3000, created_at: before },
  ];
  const detail = mapListingDetail({
    id: "103",
    price: 3000,
    listing_type: "sell",
    price_history: rawHistory,
    location: { lat: "44.77", lon: "17.19" },
    attributes: [{ attr_code: "kvadrata", value: "72,5" }],
  });
  assert.equal(detail.price, 3000);
  assert.equal(detail.sqm, 72.5);
  assert.equal(detail.ppm2, undefined);
  assert.equal(detail.latitude, 44.77);
  assert.equal(detail.longitude, 17.19);
  assert.deepEqual(detail.sourcePriceHistory, rawHistory);
  assert.deepEqual(detail.apiPriceHistory, [{ price: 3000, date: before }]);
  assert.equal(detail.priceHistoryRejections[0].reason, "duplicate");
});

test("detail: declared ad kind overrides a contradicting listing_type", () => {
  // A real live case: a 3.000 KM/month house rental posted as a sale.
  const rental = mapListingDetail({
    id: "79447263",
    price: 120,
    listing_type: "sell",
    attributes: [{ attr_code: "vrsta-oglasa", value: "Iznajmljivanje" }],
  });
  assert.equal(rental.dealType, "rent");
  assert.equal(rental.isRent, true);
  // The rent minimum applies, so a nightly holiday-home price survives.
  assert.equal(rental.price, 120);
  const sale = mapListingDetail({
    id: "104",
    price: 90000,
    listing_type: "rent",
    attributes: [{ attr_code: "vrsta-oglasa", value: "Prodaja" }],
  });
  assert.equal(sale.dealType, "sale");
  const fallback = mapListingDetail({
    id: "105",
    price: 500,
    listing_type: "rent",
    attributes: [{ attr_code: "vrsta-oglasa", value: "Zamjena" }],
  });
  assert.equal(fallback.dealType, "rent");
  // The daily-rent category outranks the declared ad kind too.
  const nightly = mapListingDetail({
    id: "106",
    price: 60,
    listing_type: "sell",
    category_id: 2668,
    attributes: [{ attr_code: "vrsta-oglasa", value: "Iznajmljivanje" }],
  });
  assert.equal(nightly.dealType, "daily_rent");
  assert.equal(nightly.propertyType, "daily_rent");
  assert.equal(nightly.price, 60);
});

test("detail: a declared sale per m² reads its history per m² too", () => {
  const now = Math.floor(Date.now() / 1000);
  const detail = mapListingDetail({
    id: "107",
    title: "Stan 60 m2",
    price: 1500,
    listing_type: "sell",
    category_id: 23,
    attributes: [
      { attr_code: "vrsta-oglasa", value: "Prodaja" },
      { attr_code: "kvadrata", value: "60" },
    ],
    price_history: [{ price: 1600, created_at: now - 100 }],
  });
  assert.equal(detail.dealType, "sale");
  assert.equal(detail.priceBasis, "per_sqm");
  assert.equal(detail.price, 90000);
  assert.deepEqual(
    detail.apiPriceHistory.map((event) => event.price),
    [96000],
  );
  // Declared sales are not reread as rentals.
  const garage = mapListingDetail({
    id: "108",
    price: 150,
    category_id: 30,
    attributes: [{ attr_code: "vrsta-oglasa", value: "Prodaja" }],
  });
  assert.equal(garage.dealType, "sale");
  assert.equal(garage.price, null);
});

test("detail: empty/garbage payload tolerated", () => {
  assert.equal(mapListingDetail(null), null);
  const d = mapListingDetail({ id: 42 });
  assert.equal(d.articleId, 42);
  assert.equal(d.sqm, null);
  assert.deepEqual(d.characteristics, {});
  assert.equal(d.apiPriceHistory, null);
  assert.equal(d.publishedAt, null);
  assert.equal(d.renewedAt, null);
});
