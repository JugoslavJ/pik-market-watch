"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  mergeDetail,
  retryEligible,
  selectDetailTargets,
} = require("../../src/detail-enrichment");

const now = new Date("2026-09-05T12:00:00Z");

test("detail queue prioritizes never fetched, then changed price, then stale", () => {
  const rows = [
    {
      articleId: 3,
      detailsFetchedAt: "2026-08-01",
      lastEnrichmentAttemptedAt: "2026-09-04",
    },
    {
      articleId: 2,
      detailsFetchedAt: "2026-08-01",
      priceChangedSinceDetail: true,
      lastEnrichmentAttemptedAt: "2026-09-04",
    },
    { articleId: 1, detailsFetchedAt: null, lastEnrichmentAttemptedAt: null },
  ];
  assert.deepEqual(
    selectDetailTargets(rows, { now }).map((x) => x.row.articleId),
    [1, 2, 3],
  );
});

test("failed detail attempts become eligible after the retry interval", () => {
  const row = {
    detailsFetchedAt: null,
    lastEnrichmentAttemptedAt: "2026-09-05T11:30:00Z",
  };
  assert.equal(retryEligible(row, now, 3600000), false);
  assert.equal(retryEligible(row, now, 1800000), true);
});

test("detail merge preserves first publication, advances renewal, and clears explicit price", () => {
  const merged = mergeDetail(
    {
      publishedAt: "2020-01-01",
      renewedAt: "2026-08-01",
      price: 100000,
      characteristics: { a: 1 },
    },
    {
      publishedAt: "2021-01-01",
      renewedAt: "2026-09-01",
      price: null,
      priceState: "unpriced",
      pricePresent: true,
      characteristics: { b: 2 },
    },
  );
  assert.equal(merged.publishedAt, "2020-01-01");
  assert.equal(merged.renewedAt, "2026-09-01");
  assert.equal(merged.price, null);
  assert.deepEqual(merged.characteristics, { a: 1, b: 2 });
});
