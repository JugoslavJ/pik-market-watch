"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLifecycleTransitionEvents,
  buildSearchObservations,
  buildSearchPriceEvents,
} = require("../../src/search-lifecycle");
const { normalizeEvent } = require("../../src/price-history");
const { parseSearchItem } = require("../../src/parser");

test("search observations use observation time", () => {
  const observedAt = new Date("2026-09-05T12:00:00Z");
  const [row] = buildSearchObservations(
    [
      {
        articleId: 4,
        renewedAt: new Date("2026-09-04T12:00:00Z"),
        price: 120000,
        searchAttributes: {},
      },
    ],
    { searchKey: "x", category: "apartments", runId: 1, observedAt },
  );
  assert.equal(row.effectiveAt, observedAt);
});

test("search price evidence keeps observation and renewal times separate", () => {
  const renewedAt = new Date("2026-09-04T12:00:00Z");
  const observedAt = new Date("2026-09-05T12:00:00Z");
  const [event] = buildSearchPriceEvents(
    [{ articleId: 4, renewedAt, price: 120000 }],
    { observedAt },
  );
  assert.equal(event.effectiveAt, observedAt);
  assert.equal(event.observedAt, observedAt);
  assert.equal(event.renewedAt, renewedAt);
  assert.equal(event.effectiveAtBasis, "observed");
});

test("search price evidence preserves deal type through canonical normalization", () => {
  const observedAt = new Date("2026-09-05T12:00:00Z");
  const rentCard = parseSearchItem({
    id: "5",
    title: "rent listing",
    listing_type: "rent",
    price: 800,
  });
  const [rentEvent] = buildSearchPriceEvents([rentCard], { observedAt });
  assert.equal(rentEvent.dealType, "rent");
  assert.equal(rentEvent.isRent, true);
  const normalizedRent = normalizeEvent(rentEvent, { now: observedAt });
  assert.equal(normalizedRent.ok, true);
  assert.equal(normalizedRent.event.price, 800);
  assert.equal(normalizedRent.event.priceState, "valid");

  const saleCard = parseSearchItem({
    id: "6",
    title: "sale listing",
    listing_type: "sell",
    price: 800,
  });
  const [saleEvent] = buildSearchPriceEvents([saleCard], { observedAt });
  assert.equal(saleEvent.dealType, "sale");
  assert.equal(saleEvent.isRent, false);
  const normalizedSale = normalizeEvent(saleEvent, { now: observedAt });
  assert.equal(normalizedSale.ok, true);
  assert.equal(normalizedSale.event.price, null);
  assert.equal(normalizedSale.event.priceState, "invalid");
});

test("lifecycle transitions preserve shared-search membership", () => {
  const events = buildLifecycleTransitionEvents({
    currentArticleIds: [2, 3],
    previousArticleIds: [1, 2],
    retainedByOtherSearch: [1],
    previouslyClosed: [3],
    runId: 9,
    searchKey: "apartments",
  });
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["reopened"],
  );
});
