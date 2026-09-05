"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLifecycleTransitionEvents,
  buildSearchObservations,
  buildSearchPriceEvents,
  collectSearchPages,
  ingestSearchRun,
  withSerializedWriter,
} = require("../../src/search-lifecycle");

const cfg = (overrides = {}) => ({
  perPage: 40,
  maxPages: 10,
  concurrency: 2,
  pageDelayMs: 0,
  apiTimeoutMs: 5,
  ...overrides,
});

const base = new URL("https://olx.ba/api/search?category_id=23&per_page=40");
const meta = (total, lastPage, currentPage) => ({
  total,
  last_page: lastPage,
  current_page: currentPage,
});

const raw = (id, overrides = {}) => ({
  id,
  title: `Stan ${id}`,
  price: 100000,
  display_price: "100.000 KM",
  listing_type: "sell",
  special_labels: [{ label: "Kvadrata", value: 50 }],
  location: { lat: 44.77, lon: 17.19 },
  date: 1787000000,
  user_type: "private",
  status: "active",
  ...overrides,
});

function fetcher(pages) {
  return async (url) => pages[Number(url.searchParams.get("page"))];
}

test("complete collection collapses sponsored duplicates but keeps unchanged price evidence", async () => {
  const result = await collectSearchPages({
    base,
    cfg: cfg(),
    fetchSearchPage: fetcher({
      1: { items: [raw(1), raw(2)], meta: meta(3, 2, 1) },
      2: { items: [raw(1), raw(3)], meta: meta(3, 2, 2) },
    }),
    pace: async () => {},
  });

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.cards.map((card) => card.articleId),
    [1, 2, 3],
  );
  const events = buildSearchPriceEvents(result.cards, {
    observedAt: new Date("2026-09-05T10:00:00Z"),
  });
  assert.equal(events.length, 3);
  assert.equal(events[0].price, 100000);
  assert.equal(result.rawResponses.length, 2);
  assert.deepEqual(result.cards[0].searchAttributes.special_labels, [
    { label: "Kvadrata", value: 50 },
  ]);
});

test("failed pagination is incomplete and never produces an authoritative replacement", async () => {
  const result = await collectSearchPages({
    base,
    cfg: cfg(),
    fetchSearchPage: async (url) => {
      const page = Number(url.searchParams.get("page"));
      if (page === 2) throw new Error("timeout");
      return { items: [raw(page)], meta: meta(3, 3, page) };
    },
    pace: async () => {},
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.failedPages, [2]);
  assert.equal(result.cards.length, 2);
  assert.match(result.failureReason, /page_2_failed/);
});

test("a page cap below the reported end is incomplete", async () => {
  const result = await collectSearchPages({
    base,
    cfg: cfg({ maxPages: 2 }),
    fetchSearchPage: fetcher({
      1: { items: [raw(1)], meta: meta(3, 3, 1) },
      2: { items: [raw(2)], meta: meta(3, 3, 2) },
    }),
    pace: async () => {},
  });
  assert.equal(result.complete, false);
  assert.match(result.truncationReason, /page_cap_before_reported_end/);
});

test("incomplete ingest archives responses and preserves prior membership by skipping commit", async () => {
  const calls = { archive: [], commit: [], finish: [] };
  const db = {
    async startRun() {
      return 7;
    },
    async registerSavedSearch() {},
    async archiveSearchResponse(row) {
      calls.archive.push(row);
    },
    async commitSearchIngestion(payload) {
      calls.commit.push(payload);
    },
    async finishRun(id, info) {
      calls.finish.push({ id, info });
    },
  };
  const result = await ingestSearchRun(
    db,
    {
      name: "Apartments",
      category: "apartments",
      url: "https://olx.ba/pretraga?category_id=23",
      searchKey: "apartments",
    },
    cfg({ maxPages: 1 }),
    () => {},
    {
      fetchSearchPage: fetcher({
        1: { items: [raw(1)], meta: meta(2, 2, 1) },
      }),
      pace: async () => {},
    },
  );

  assert.equal(result.complete, false);
  assert.equal(calls.archive.length, 1);
  assert.equal(calls.commit.length, 0);
  assert.equal(calls.finish[0].info.isComplete, false);
  assert.match(calls.finish[0].info.truncationReason, /page_cap/);
});

test("successful payload carries all search state and asks the facade to preserve missing area", async () => {
  const calls = [];
  const db = {
    async startRun() {
      return 8;
    },
    async registerSavedSearch() {},
    async archiveSearchResponse() {},
    async commitSearchIngestion(payload) {
      calls.push(payload);
    },
  };
  await ingestSearchRun(
    db,
    {
      name: "Apartments",
      category: "apartments",
      url: "https://olx.ba/pretraga?category_id=23",
      searchKey: "apartments",
    },
    cfg(),
    () => {},
    {
      fetchSearchPage: fetcher({
        1: { items: [raw(1, { special_labels: [] })], meta: meta(1, 1, 1) },
      }),
      pace: async () => {},
    },
  );

  const payload = calls[0];
  assert.equal(payload.cards[0].sqm, null);
  assert.equal(payload.preserveMissingArea, true);
  assert.equal(payload.recomputePpm2, true);
  assert.deepEqual(payload.membership.articleIds, [1]);
  assert.equal(
    payload.stateObservations[0].categoryMembership[0],
    "apartments",
  );
  assert.equal(payload.priceEvents[0].priceState, "valid");
});

test("lifecycle transitions close only when no other search retains an article and reopen later", () => {
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
  assert.equal(events[0].articleId, 3);
});

test("writer cycles serialize overlapping searches", async () => {
  const db = {};
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = withSerializedWriter(db, async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  const second = withSerializedWriter(db, async () => order.push("second"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("search observations preserve normalized card fields and raw attributes", () => {
  const card = {
    articleId: 4,
    renewedAt: new Date("2026-09-04T12:00:00Z"),
    isRent: false,
    sqm: null,
    rooms: "2",
    price: 120000,
    ppm2: null,
    priceState: "valid",
    searchAttributes: { special_labels: [{ label: "Kvadrata", value: null }] },
  };
  const [observation] = buildSearchObservations([card], {
    searchKey: "x",
    category: "apartments",
    runId: 1,
  });
  assert.equal(observation.sqm, null);
  assert.equal(
    observation.effectiveAt.toISOString(),
    "2026-09-04T12:00:00.000Z",
  );
  assert.deepEqual(
    observation.filterAttributes.searchAttributes,
    card.searchAttributes,
  );
});
