"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeEvent } = require("../../src/price-history");
const { legacyEvents } = require("../../src/price-history-backfill");

test("canonical importer keeps source time separate and accepts valid history without area", () => {
  const result = normalizeEvent(
    {
      articleId: "42",
      effectiveAt: "2024-01-02T10:00:00Z",
      price: 3000,
      source: "legacy_price_history",
      historical: true,
    },
    { now: new Date("2025-01-01T00:00:00Z") },
  );
  assert.equal(result.ok, true);
  assert.equal(result.event.price, 3000);
  assert.equal(
    result.event.effectiveAt.toISOString(),
    "2024-01-02T10:00:00.000Z",
  );
  assert.equal(result.event.ingestedAt, null);
});

test("current unpriced observations become null boundaries, historical invalid prices are quarantined", () => {
  const current = normalizeEvent({
    articleId: 7,
    effectiveAt: "2025-01-01T00:00:00Z",
    price: "Na upit",
    source: "search",
    isCurrent: true,
  });
  assert.equal(current.ok, true);
  assert.equal(current.event.price, null);
  assert.equal(current.event.priceState, "unpriced");

  const historical = normalizeEvent({
    articleId: 7,
    effectiveAt: "2024-01-01T00:00:00Z",
    price: 25,
    source: "legacy_price_history",
    historical: true,
    dealType: "sale",
  });
  assert.deepEqual(historical, { ok: false, reason: "historical_invalid" });
});

test("backfill converts both legacy sources, preserves overlaps for importer dedupe, and quarantines malformed rows", () => {
  const converted = legacyEvents(
    {
      article_id: 99,
      is_rent: false,
      api_price_history: [
        { price: 100000, created_at: 1704067200 },
        { price: 12, created_at: 1704067201 },
      ],
      closed_at: new Date("2024-03-01T00:00:00Z"),
    },
    [
      {
        id: 1,
        article_id: 99,
        scraped_at: new Date("2024-01-01T00:00:00Z"),
        price: 100000,
      },
      { id: 2, article_id: 99, scraped_at: null, price: 90000 },
    ],
  );
  assert.equal(converted.events.length, 2);
  assert.equal(converted.quarantined, 2);
  assert.equal(converted.events[0].source, "legacy_price_history");
  assert.equal(converted.events[1].source, "legacy_api_price_history");
});
