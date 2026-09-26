"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeEvent } = require("../../src/price-history");

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
  assert.equal(result.event.effectiveAtBasis, "legacy");
  assert.equal(
    result.event.observedAt.toISOString(),
    result.event.effectiveAt.toISOString(),
  );
  assert.equal(result.event.ingestedAt, null);
});

test("current evidence stores observation and renewal metadata separately", () => {
  const observedAt = new Date("2026-09-05T12:00:00Z");
  const renewedAt = new Date("2026-09-04T12:00:00Z");
  const result = normalizeEvent(
    {
      articleId: 43,
      effectiveAt: observedAt,
      observedAt,
      renewedAt,
      effectiveAtBasis: "observed",
      price: 100000,
      source: "search",
      isCurrent: true,
    },
    { now: observedAt },
  );
  assert.equal(result.ok, true);
  assert.equal(result.event.observedAt.getTime(), observedAt.getTime());
  assert.equal(result.event.renewedAt.getTime(), renewedAt.getTime());
  assert.equal(result.event.effectiveAtBasis, "observed");
});

test("normalized currency is carried as an indexed event identity field", () => {
  const bam = normalizeEvent({
    articleId: 44,
    effectiveAt: "2026-09-05T12:00:00Z",
    price: 100000,
    source: "search",
    isCurrent: true,
    provenance: { currency: "KM" },
  });
  const eur = normalizeEvent({
    articleId: 44,
    effectiveAt: "2026-09-05T12:00:00Z",
    price: 100000,
    source: "detail",
    isCurrent: true,
    provenance: { currency: "EUR" },
  });
  assert.equal(bam.event.currency, "BAM");
  assert.equal(eur.event.currency, "EUR");
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
