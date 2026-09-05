"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PRICE_STATES,
  dateFromUnixSeconds,
  normalizeArea,
  normalizeHistoryWithRejections,
  normalizeId,
  normalizeLegacyPriceHistory,
  normalizePpm2,
  normalizePrice,
  normalizePriceHistory,
} = require("../../src/normalization");
const { parseListingDetail, parseSearchItem } = require("../../src/parser");

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
  assert.equal(normalizePrice("not a number", "sale").reason, "not_numeric");
  assert.equal(normalizePrice(Infinity, "sale").reason, "not_numeric");
});

test("numeric IDs, locale strings, area bounds and missing-area prices are safe", () => {
  assert.equal(normalizeId(" 69441462 "), 69441462);
  assert.equal(normalizeId(1.5), null);
  assert.equal(normalizeId("999999999999999999999"), null);
  assert.equal(normalizePrice("26.000", "sale").price, 26000);
  assert.equal(normalizeArea("72,5"), 72.5);
  assert.equal(normalizeArea(4), null);
  assert.equal(normalizeArea(501), null);
  assert.equal(normalizePpm2(3000, null, "sale"), null);
  assert.equal(normalizePpm2(3000, 5, "sale"), 600);
  assert.equal(normalizePpm2(3000, 1, "sale"), null);
});

test("history accepts API and stored formats, sorts and exact-deduplicates", () => {
  const entries = [
    { price: "3.000", date: BEFORE },
    { price: 4000, created_at: BEFORE - 20 },
    { price: 4000, created_at: BEFORE - 20 },
  ];
  assert.deepEqual(
    normalizePriceHistory(entries, { dealType: "sale", now: NOW }),
    [
      { price: 4000, date: BEFORE - 20 },
      { price: 3000, date: BEFORE },
    ],
  );
  assert.deepEqual(
    normalizeLegacyPriceHistory(
      JSON.stringify([{ price: "50", date: BEFORE }]),
      {
        dealType: "rent",
        now: NOW,
      },
    ),
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

test("declared sale remains sale when its price is invalid; valid price works without area", () => {
  const cheapSale = parseSearchItem({
    id: "101",
    title: "cheap declared sale",
    listing_type: "sell",
    price: "2.999",
  });
  assert.equal(cheapSale.isRent, false);
  assert.equal(cheapSale.dealType, "sale");
  assert.equal(cheapSale.priceState, "invalid");
  assert.equal(cheapSale.price, null);

  const validNoArea = parseSearchItem({
    id: 102,
    title: "sale with unknown area",
    listing_type: "sell",
    price: "3.000",
  });
  assert.equal(validNoArea.priceState, "valid");
  assert.equal(validNoArea.price, 3000);
  assert.equal(validNoArea.ppm2, null);
});

test("detail preserves characteristics, pin mapping and raw history separately", () => {
  const rawHistory = [
    { price: 3000, created_at: BEFORE },
    { price: 3000, created_at: BEFORE },
  ];
  const detail = parseListingDetail({
    id: "103",
    price: 3000,
    listing_type: "sell",
    price_history: rawHistory,
    location: { lat: "44.77", lon: "17.19" },
    attributes: [
      { attr_code: "kvadrata", value: "72,5" },
      { attr_code: "parking", value: "Da" },
      { attr_code: "unknown", value: "kept" },
    ],
  });
  assert.equal(detail.price, 3000);
  assert.equal(detail.sqm, 72.5);
  assert.equal(detail.ppm2, 41);
  assert.equal(detail.parking, true);
  assert.equal(detail.characteristics.unknown, "kept");
  assert.equal(detail.latitude, 44.77);
  assert.deepEqual(detail.sourcePriceHistory, rawHistory);
  assert.deepEqual(detail.apiPriceHistory, [{ price: 3000, date: BEFORE }]);
  assert.equal(detail.priceHistoryRejections[0].reason, "duplicate");
});

test("current timestamps require Unix seconds, not milliseconds or fractions", () => {
  assert.deepEqual(
    dateFromUnixSeconds("1752875036"),
    new Date(1752875036 * 1000),
  );
  assert.equal(dateFromUnixSeconds(1752875036.5), null);
  assert.equal(dateFromUnixSeconds(1752875036000), null);
});
