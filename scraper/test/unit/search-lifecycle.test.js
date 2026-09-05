"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLifecycleTransitionEvents,
  buildSearchObservations,
  buildSearchPriceEvents,
} = require("../../src/search-lifecycle");

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

test("search price evidence retains renewal time", () => {
  const renewedAt = new Date("2026-09-04T12:00:00Z");
  const [event] = buildSearchPriceEvents(
    [{ articleId: 4, renewedAt, price: 120000 }],
    { observedAt: new Date("2026-09-05T12:00:00Z") },
  );
  assert.equal(event.effectiveAt, renewedAt);
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
