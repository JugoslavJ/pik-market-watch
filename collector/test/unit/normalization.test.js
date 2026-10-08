"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PRICE_STATES,
  dateFromUnixSeconds,
  finiteNumber,
  normalizeArea,
  normalizeHistoryWithRejections,
  normalizeId,
  normalizePrice,
  propertyTypeOf,
  readPrice,
} = require("../../src/normalization");

const NOW = Date.parse("2026-09-05T12:00:00Z");
const BEFORE = Math.floor(NOW / 1000) - 100;

test("price policy keeps explicit states and exact deal thresholds", () => {
  assert.equal(normalizePrice(0, "sale").state, PRICE_STATES.UNPRICED);
  assert.equal(normalizePrice(null, "sale").state, PRICE_STATES.UNPRICED);
  assert.deepEqual(normalizePrice(2999, "sale"), {
    price: null,
    state: "invalid",
    reason: "below_sale_minimum",
  });
  assert.equal(normalizePrice("3.000", "sale").price, 3000);
  assert.equal(normalizePrice(49, "rent").reason, "below_rent_minimum");
  assert.equal(normalizePrice(50, "rent").state, PRICE_STATES.VALID);
  assert.equal(
    normalizePrice(9, "daily_rent").reason,
    "below_daily_rent_minimum",
  );
  assert.equal(normalizePrice(10, "daily_rent").state, PRICE_STATES.VALID);
  assert.equal(normalizePrice("not a number", "sale").reason, "not_numeric");
  assert.equal(normalizePrice(Infinity, "sale").reason, "not_numeric");
});

test("OLX real-estate subcategories name the property type", () => {
  assert.equal(propertyTypeOf(23), "apartments");
  assert.equal(propertyTypeOf("2668"), "daily_rent");
  assert.equal(propertyTypeOf(25), "commercial");
  assert.equal(propertyTypeOf(2672), "warehouses");
  // A subcategory OLX adds later still counts as real estate.
  assert.equal(propertyTypeOf(9999), "other");
  assert.equal(propertyTypeOf(undefined), null);
  assert.equal(propertyTypeOf("2a"), null);
});

test("numeric IDs, locale strings, area bounds and missing-area prices are safe", () => {
  assert.equal(normalizeId(" 69441462 "), 69441462);
  assert.equal(normalizeId(1.5), null);
  assert.equal(normalizeId("999999999999999999999"), null);
  assert.equal(normalizePrice("26.000", "sale").price, 26000);
  assert.equal(normalizeArea("72,5"), 72.5);
  assert.equal(normalizeArea(4), null);
  // Land and commercial space run far past apartment sizes.
  assert.equal(normalizeArea(32000), 32000);
  assert.equal(normalizeArea(2000000), null);
  // Three-digit groups are thousands; other decimals stay decimals.
  assert.equal(normalizeArea("1.036"), 1036);
  assert.equal(normalizeArea("7.500"), 7500);
  assert.equal(normalizeArea("1,5"), null);
  assert.equal(normalizeArea("7,5"), 7.5);
});

test("sale-posted rents and per-m² prices are read as what they are", () => {
  const read = (price, listing) =>
    readPrice(price, { dealType: "sale", ...listing });
  // A garage, office or room "sale" under the minimum is a monthly rent.
  for (const propertyType of ["garages", "commercial", "rooms", "houses"]) {
    assert.deepEqual(read(150, { propertyType }), {
      price: 150,
      state: "valid",
      reason: null,
      dealType: "rent",
      basis: "total",
    });
  }
  // Garages and prefab units still sell for a few thousand KM.
  assert.equal(read(2700, { propertyType: "garages" }).dealType, "sale");
  assert.equal(read(1000, { propertyType: "prefab" }).price, 1000);
  // Land asks per m²; the total needs the area.
  assert.deepEqual(read(40, { propertyType: "land", sqm: 3607 }), {
    price: 144280,
    state: "valid",
    reason: null,
    dealType: "sale",
    basis: "per_sqm",
  });
  assert.equal(
    read(40, { propertyType: "land" }).reason,
    "per_sqm_without_area",
  );
  // Real live case: a plot "with its business space" at 1,500 KM is a rent.
  assert.equal(read(1500, { propertyType: "land", sqm: 624 }).dealType, "rent");
  // Holiday homes at a nightly price are daily rentals, however posted.
  const cottage = { propertyType: "vacation_homes" };
  assert.equal(read(50, cottage).dealType, "daily_rent");
  assert.equal(
    read(50, { ...cottage, title: "Iznajmljivanje" }).dealType,
    "daily_rent",
  );
  assert.equal(
    readPrice(80, { dealType: "rent", declared: true, ...cottage }).dealType,
    "daily_rent",
  );
  assert.equal(read(500, cottage).dealType, "rent");
  assert.equal(read(95000, cottage).dealType, "sale");
  // Homes: a rent unless the figure can only be a price per m².
  const flat = { propertyType: "apartments", sqm: 60 };
  assert.equal(read(700, flat).dealType, "rent");
  assert.equal(read(1800, flat).price, 108000);
  assert.equal(read(700, { ...flat, title: "Prodaja stana" }).price, 42000);
  assert.equal(read(1800, { ...flat, title: "Najam stana" }).dealType, "rent");
  // An ad declaring a sale is never turned into a rental.
  const declared = read(150, { propertyType: "garages", declared: true });
  assert.equal(declared.dealType, "sale");
  assert.equal(declared.reason, "below_sale_minimum");
  // Ordinary prices pass through untouched.
  assert.equal(read(150000, flat).basis, "total");
  assert.equal(readPrice(600, { dealType: "rent", ...flat }).dealType, "rent");
});

test("price history follows the current price's per-m² reading", () => {
  const { events } = normalizeHistoryWithRejections(
    [
      { price: 45, created_at: BEFORE - 10 },
      { price: 40, created_at: BEFORE },
    ],
    {
      dealType: "sale",
      propertyType: "land",
      basis: "per_sqm",
      sqm: 1000,
      now: NOW,
    },
  );
  assert.deepEqual(
    events.map((event) => event.price),
    [45000, 40000],
  );
});

test("localized numbers accept validated grouping and decimal separators", () => {
  assert.equal(finiteNumber("1.234,50"), 1234.5);
  assert.equal(finiteNumber("1,234.50"), 1234.5);
  assert.equal(finiteNumber("12.345,67", { integerLike: true }), 12345.67);
  assert.equal(finiteNumber("72,5"), 72.5);
  assert.equal(finiteNumber("1.23.456"), null);
  assert.equal(finiteNumber("1.234,5.6"), null);
});

test("history accepts API and stored formats, sorts and exact-deduplicates", () => {
  const entries = [
    { price: "3.000", date: BEFORE },
    { price: 4000, created_at: BEFORE - 20 },
    { price: 4000, created_at: BEFORE - 20 },
  ];
  assert.deepEqual(
    normalizeHistoryWithRejections(entries, { dealType: "sale", now: NOW })
      .events,
    [
      { price: 4000, date: BEFORE - 20 },
      { price: 3000, date: BEFORE },
    ],
  );
  assert.deepEqual(
    normalizeHistoryWithRejections(
      JSON.stringify([{ price: "50", date: BEFORE }]),
      {
        dealType: "rent",
        now: NOW,
      },
    ).events,
    [{ price: 50, date: BEFORE }],
  );
});

test("history rejects missing, malformed and future timestamps without import time", () => {
  const result = normalizeHistoryWithRejections(
    [
      { price: 3000, created_at: BEFORE },
      { price: 4000, created_at: BEFORE + 1000 },
      { price: 5000, created_at: "bad" },
      { price: 6000 },
    ],
    { dealType: "sale", now: NOW },
  );
  assert.deepEqual(result.events, [{ price: 3000, date: BEFORE }]);
  assert.deepEqual(
    result.rejected.map((entry) => entry.reason),
    ["future_timestamp", "invalid_timestamp", "invalid_timestamp"],
  );
});

test("current timestamps require Unix seconds, not milliseconds or fractions", () => {
  assert.deepEqual(
    dateFromUnixSeconds("1752875036"),
    new Date(1752875036 * 1000),
  );
  assert.equal(dateFromUnixSeconds(1752875036.5), null);
  assert.equal(dateFromUnixSeconds(1752875036000), null);
});
