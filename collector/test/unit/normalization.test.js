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
