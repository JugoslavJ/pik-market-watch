"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  priceCurrencyOf,
  normalizeHistoryWithRejections,
} = require("../../src/normalization");
const { parseSearchItem, parseListingDetail } = require("../../src/parser");
const {
  buildSearchObservations,
  buildSearchPriceEvents,
} = require("../../src/search-lifecycle");

test("currency requires source evidence and preserves foreign/conflicting assertions", () => {
  assert.equal(priceCurrencyOf({ price: 600 }), null);
  assert.equal(priceCurrencyOf({ price: 600, display_price: "600 KM" }), "BAM");
  assert.equal(priceCurrencyOf({ price: "600 BAM", currency: "KM" }), "BAM");
  assert.equal(priceCurrencyOf({ price: "600 €" }), "EUR");
  assert.equal(priceCurrencyOf({ price: 600, currency: "RSD" }), "RSD");
  assert.equal(
    priceCurrencyOf({ price: 600, currency: "EUR", display_price: "600 KM" }),
    "conflict",
  );
  assert.equal(
    priceCurrencyOf({ price: 600, currency: {}, display_price: "600 KM" }),
    "unknown",
  );
});

test("search and detail carry currency into assertion and state evidence", () => {
  const payload = {
    id: 123,
    title: "Rental apartment",
    listing_type: "rent",
    price: 600,
    display_price: "600 KM",
  };
  const card = parseSearchItem(payload);
  assert.equal(card.priceCurrency, "BAM");
  assert.equal(buildSearchPriceEvents([card])[0].provenance.currency, "BAM");
  assert.equal(
    buildSearchObservations([card], {
      searchKey: "test",
      category: "apartments",
    })[0].filterAttributes.currency,
    "BAM",
  );
  assert.equal(parseListingDetail(payload).priceCurrency, "BAM");
  assert.equal(
    parseListingDetail({ ...payload, display_price: undefined }).priceCurrency,
    null,
  );
});

test("historical currency is retained per event without borrowing today's currency", () => {
  const date = 1700000000;
  const payload = {
    id: 123,
    price: 600,
    display_price: "600 KM",
    listing_type: "rent",
    price_history: [
      { price: 700, date },
      { price: 700, date, currency: "EUR" },
      { price: 750, date: date + 1, display_price: "750 KM" },
    ],
  };
  const events = parseListingDetail(payload).apiPriceHistory;
  assert.equal(events.length, 3);
  assert.equal(events[0].currency, undefined);
  assert.equal(events[1].currency, "EUR");
  assert.equal(events[2].currency, "BAM");
  assert.deepEqual(
    normalizeHistoryWithRejections(events, { dealType: "rent" }).events,
    events,
  );
});

test("partial furnishing stays unknown regardless of coarse flag ordering", () => {
  const partial = { attr_code: "opremljenost", value: "Polunamješten" };
  const yes = { attr_code: "namjesten", value: "Da" };
  for (const attributes of [
    [partial, yes],
    [yes, partial],
  ]) {
    assert.equal(parseListingDetail({ id: 123, attributes }).furnished, null);
  }
});

test("missing source deal type remains explicit unknown price evidence", () => {
  const card = parseSearchItem({
    id: 123,
    title: "Unknown deal apartment",
    price: 150000,
    display_price: "150.000 KM",
  });
  assert.equal(card.dealType, null);
  assert.equal(buildSearchPriceEvents([card])[0].provenance.dealType, null);
});
