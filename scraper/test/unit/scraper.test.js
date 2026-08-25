"use strict";
// Unit tests for scraper.js — pagination termination rules, cross/same-page
// dedupe, rate-budget latching, error-path bookkeeping and the enrichment
// need-detail/merge logic. Everything runs OFFLINE through scrapeSearch()'s
// dependency seam (fetchSearchPage / fetchDetailsInBatches / pace fakes);
// the real parser and stats math stay in the loop on purpose.
const test = require("node:test");
const assert = require("node:assert/strict");
const { scrapeSearch, pagesInWave } = require("../../src/scraper");
const { RATE_RESERVE } = require("../../src/api");

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Raw search-API card shaped so the REAL parseSearchItem accepts it. */
const rawCard = (id) => ({
  id,
  title: `Stan ${id}`,
  price: 100000,
  display_price: "100.000 KM",
  listing_type: "sell",
  special_labels: [{ value: 50, label: "Kvadrata", unit: "㎡" }],
  location: { lat: 44.77, lon: 17.19 },
  date: 1787000000,
  user_type: "private",
  status: "active",
});

const meta = (total, lastPage, current) => ({
  total,
  last_page: lastPage,
  current_page: current,
});

const SEARCH = {
  name: "T",
  category: "apartments",
  url: "https://olx.ba/pretraga?category_id=23",
  searchKey: "/pretraga?category_id=23",
};

const baseCfg = (overrides) => ({
  maxPages: 30,
  concurrency: 2,
  pageDelayMs: 0,
  perPage: 40,
  apiTimeoutMs: 5,
  maxGeoFetches: 25,
  geoConcurrency: 2,
  geoDelayMs: 0,
  ...overrides,
});

/** Recording db double — enough surface for scrapeSearch, nothing more. */
function fakeDb(queueImpl) {
  const rec = {
    startRun: 0,
    savedSearches: [],
    upserts: [],
    refreshed: [],
    enriched: [],
    finishedRuns: [],
  };
  return {
    rec,
    async startRun() {
      rec.startRun += 1;
      return 1;
    },
    async registerSavedSearch(s) {
      rec.savedSearches.push(s);
    },
    async saveCards(cards) {
      rec.savedCards = cards;
      return { newCount: cards.length, dropCount: 0 };
    },
    async upsertSavedSearch(u) {
      rec.upserts.push(u);
    },
    async refreshSearchResults(_key, ids) {
      rec.refreshed.push(ids);
    },
    async enrichmentQueue(ids, cap) {
      return queueImpl
        ? queueImpl(ids, cap)
        : { pending: [], total: ids.length };
    },
    async enrichListings(rows) {
      rec.enriched.push(...rows);
    },
    async finishRun(_id, info) {
      rec.finishedRuns.push(info);
    },
    async hasRecentFinishedRun() {
      return false;
    },
  };
}

/** Page-fetch fake: map of pageNo → response; records visit order; can throw. */
function pageFetcher(pages) {
  const fetched = [];
  const failOn = pages.__failOn || [];
  const fn = async (url) => {
    const no = Number(url.searchParams.get("page"));
    fetched.push(no);
    if (failOn.includes(no)) throw new Error(`HTTP 500 for page ${no}`);
    const p = pages[no];
    if (!p) throw new Error(`fake has no page ${no}`);
    return p;
  };
  fn.fetched = fetched;
  return fn;
}

/** Pacing fake: records requested delays instead of waiting. */
function paceRecorder() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}

const run = (db, cfg, deps) =>
  scrapeSearch(db, SEARCH, baseCfg(cfg), () => {}, deps);

// ── pagination ───────────────────────────────────────────────────────────────

test("single-page search: one fetch, ok run, correct stats and refresh", async () => {
  const db = fakeDb();
  const fetchPage = pageFetcher({
    1: { items: [rawCard(1), rawCard(2)], meta: meta(2, 1, 1) },
  });
  const res = await run(db, {}, { fetchSearchPage: fetchPage });

  assert.deepEqual(fetchPage.fetched, [1]);
  assert.deepEqual(res, {
    pages: 1,
    cards: 2,
    newCount: 2,
    dropCount: 0,
    enriched: 0,
  });
  assert.deepEqual(db.rec.finishedRuns, [{ status: "ok", pages: 1, cards: 2 }]);
  assert.deepEqual(db.rec.refreshed, [[1, 2]]);
  assert.equal(db.rec.upserts[0].listingCount, 2);
});

test("multi-page search: waves cover pages 2..last_page", async () => {
  const db = fakeDb();
  const fetchPage = pageFetcher({
    1: { items: [rawCard(1), rawCard(2)], meta: meta(6, 3, 1) },
    2: { items: [rawCard(3), rawCard(4)], meta: meta(6, 3, 2) },
    3: { items: [rawCard(5), rawCard(6)], meta: meta(6, 3, 3) },
  });
  const res = await run(db, {}, { fetchSearchPage: fetchPage });

  assert.deepEqual(
    [...fetchPage.fetched].sort((a, b) => a - b),
    [1, 2, 3],
  );
  assert.equal(res.pages, 3);
  assert.equal(res.cards, 6);
});

test("wave of pure duplicates stops pagination (OLX repeats past the end)", async () => {
  const dupes = [rawCard(1), rawCard(2)];
  const db = fakeDb();
  const fetchPage = pageFetcher({
    1: { items: dupes, meta: meta(4, 2, 1) },
    2: { items: dupes, meta: meta(4, 2, 2) }, // same ids → freshInWave 0
  });
  const res = await run(db, {}, { fetchSearchPage: fetchPage });

  assert.deepEqual(fetchPage.fetched, [1, 2]); // stopped right there
  assert.equal(res.cards, 2); // uniques only
  assert.deepEqual(db.rec.refreshed, [[1, 2]]); // dupes collapsed
});

test("empty page mid-wave: fresh sibling page still accepted, then stops", async () => {
  const db = fakeDb();
  const fetchPage = pageFetcher({
    1: { items: [rawCard(1)], meta: meta(3, 3, 1) },
    2: { items: [], meta: meta(3, 3, 2) }, // empty → sawEmpty
    3: { items: [rawCard(9)], meta: meta(3, 3, 3) },
  });
  const res = await run(db, {}, { fetchSearchPage: fetchPage });

  assert.deepEqual(fetchPage.fetched, [1, 2, 3]);
  assert.equal(res.cards, 2); // page 3's fresh item kept…
  assert.deepEqual(db.rec.finishedRuns, [{ status: "ok", pages: 3, cards: 2 }]);
  // …and pagination did NOT continue past the wave containing the empty page.
});

test("MAX_PAGES caps pagination even when last_page is huge", async () => {
  const db = fakeDb();
  const fetchPage = pageFetcher({
    1: { items: [rawCard(1)], meta: meta(9999, 99, 1) },
    2: { items: [rawCard(2)], meta: meta(9999, 99, 2) },
  });
  const res = await run(db, { maxPages: 2 }, { fetchSearchPage: fetchPage });

  assert.deepEqual(
    [...fetchPage.fetched].sort((a, b) => a - b),
    [1, 2],
  );
  assert.equal(res.pages, 2);
});

test("a failing page inside a wave is tolerated as empty (run stays ok)", async () => {
  const db = fakeDb();
  const fetchPage = pageFetcher({
    __failOn: [2],
    1: { items: [rawCard(1)], meta: meta(3, 3, 1) },
    3: { items: [rawCard(3)], meta: meta(3, 3, 3) },
  });
  const res = await run(db, {}, { fetchSearchPage: fetchPage });

  assert.deepEqual(db.rec.finishedRuns, [{ status: "ok", pages: 3, cards: 2 }]);
  assert.equal(res.newCount, 2);
});

// ── rate budget ──────────────────────────────────────────────────────────────

test("low rate budget pauses once (65 s), latch prevents repeat backoffs", async () => {
  const low = RATE_RESERVE - 1;
  const db = fakeDb();
  const fetchPage = pageFetcher({
    1: { items: [rawCard(1)], remaining: low, meta: meta(2, 2, 1) },
    2: { items: [rawCard(2)], remaining: low, meta: meta(2, 2, 2) },
  });
  const pace = paceRecorder();
  await run(db, {}, { fetchSearchPage: fetchPage, pace });

  // Exactly one real backoff; other pace() calls are 0 ms wave gaps.
  const backoffs = pace.delays.filter((ms) => ms >= 60000);
  assert.deepEqual(backoffs, [65000]);
});

// ── guards & error paths ─────────────────────────────────────────────────────

test("filterless URL fails LOUDLY before touching the database", async () => {
  const db = fakeDb();
  await assert.rejects(
    scrapeSearch(
      db,
      { ...SEARCH, url: "https://olx.ba/pretraga?foo=bar" },
      baseCfg(),
      () => {},
    ),
    /no API-recognized filter/,
  );
  assert.equal(db.rec.startRun, 0);
  assert.equal(db.rec.finishedRuns.length, 0);
});

test("blank page 1: one retry, then loud failure with an error run record", async () => {
  let page1Visits = 0;
  const fetchPage = async (url) => {
    if (Number(url.searchParams.get("page")) !== 1)
      throw new Error("should stop at page 1");
    page1Visits += 1;
    return { items: [], meta: meta(0, 1, 1) };
  };
  const db = fakeDb();

  await assert.rejects(
    run(db, {}, { fetchSearchPage: fetchPage }),
    /0 listings after retry/,
  );
  assert.equal(page1Visits, 2); // initial + single retry
  assert.equal(db.rec.savedSearches.length, 1); // identity registered first…
  assert.match(db.rec.finishedRuns[0].error, /0 listings/);
  assert.equal(db.rec.finishedRuns[0].status, "error"); // …run marked failed
});

// ── enrichment ───────────────────────────────────────────────────────────────

test("enrichment: detail calls only where search cards cannot answer", async () => {
  // pending facts vs what each card carries:
  //   10 neverDetailed            -> needs detail
  //   20 missingSqm, card HAS m²  -> no detail
  //   21 missingSqm, card w/o m²  -> needs detail
  //   22 unpinned,     card w/o pin -> needs detail
  //   23 unpinned,     card HAS pin -> no detail
  //   24 neverDetailed but vanished from results -> dropped entirely
  const cardWithSqm = { ...rawCard(20) }; // has Kvadrata
  const cardNoSqm = { ...rawCard(21), special_labels: [] };
  const cardNoPin = { ...rawCard(22), location: null };
  const cardWithPin = { ...rawCard(23) }; // has location

  const db = fakeDb(() => ({
    pending: [
      { id: 10, unpinned: false, missingSqm: false, neverDetailed: true },
      { id: 20, unpinned: false, missingSqm: true, neverDetailed: false },
      { id: 21, unpinned: false, missingSqm: true, neverDetailed: false },
      { id: 22, unpinned: true, missingSqm: false, neverDetailed: false },
      { id: 23, unpinned: true, missingSqm: false, neverDetailed: false },
      { id: 24, unpinned: false, missingSqm: false, neverDetailed: true },
    ],
    total: 6,
  }));

  const detailIds = [];
  const fetchDetailsInBatches = async (ids) => {
    detailIds.push(...ids);
    return ids.map((id) => ({
      articleId: id,
      sqm: 99,
      latitude: 44.5,
      longitude: 17.1,
      views: 42,
      characteristics: { grijanje: "plin" },
      apiStatus: "active",
      apiPriceHistory: null,
      publishedAt: new Date("2026-01-01"),
      renewedAt: null,
    }));
  };

  const fetchPage = pageFetcher({
    1: {
      items: [rawCard(10), cardWithSqm, cardNoSqm, cardNoPin, cardWithPin],
      meta: meta(5, 1, 1),
    },
  });

  const res = await run(
    db,
    {},
    { fetchSearchPage: fetchPage, fetchDetailsInBatches },
  );

  assert.deepEqual(detailIds, [10, 21, 22]); // exactly the gaps
  assert.equal(res.enriched, 5); // 24 had no card → skipped
  const byId = Object.fromEntries(db.rec.enriched.map((r) => [r.articleId, r]));
  assert.equal(byId[10].sqm, 99); // detail fact wins…
  assert.equal(byId[20].sqm, 50); // …card fact kept when no detail ran
  assert.equal(byId[23].latitude, 44.77); // card pin survives
});

test("enrichment merge: null/empty detail fields never clobber known facts", async () => {
  const db = fakeDb(() => ({
    pending: [
      { id: 30, unpinned: false, missingSqm: false, neverDetailed: true },
    ],
    total: 1,
  }));
  const fetchDetailsInBatches = async ([id]) => [
    {
      articleId: id,
      sqm: null, // detail does not know m² → keep card's
      views: 7, // detail adds something new
      characteristics: {}, // empty map → skipped
      apiPriceHistory: null, // null → skipped
    },
  ];
  const fetchPage = pageFetcher({
    1: { items: [rawCard(30)], meta: meta(1, 1, 1) },
  });

  await run(db, {}, { fetchSearchPage: fetchPage, fetchDetailsInBatches });
  const row = db.rec.enriched[0];
  assert.equal(row.sqm, 50);
  assert.equal(row.views, 7);
  assert.equal(row.characteristics, undefined);
  assert.equal(row.apiPriceHistory, undefined);
});

test("MAX_GEO_FETCHES=0 disables the enrichment pass entirely", async () => {
  let queueCalled = false;
  const db = fakeDb(() => {
    queueCalled = true;
    return { pending: [], total: 0 };
  });
  const fetchPage = pageFetcher({
    1: { items: [rawCard(1)], meta: meta(1, 1, 1) },
  });
  const res = await run(
    db,
    { maxGeoFetches: 0 },
    { fetchSearchPage: fetchPage },
  );

  assert.equal(queueCalled, false);
  assert.equal(res.enriched, 0);
});

// ── pagesInWave: pure pagination boundary rules ──────────────────────────────

test("pagesInWave: full wave strides by concurrency from page 2", () => {
  assert.deepEqual(
    pagesInWave(2, Infinity, baseCfg({ concurrency: 3 })),
    [2, 3, 4],
  );
  assert.deepEqual(
    pagesInWave(5, Infinity, baseCfg({ concurrency: 3 })),
    [5, 6, 7],
  );
});

test("pagesInWave: clamps mid-wave to the API-reported last_page", () => {
  assert.deepEqual(pagesInWave(2, 3, baseCfg({ concurrency: 3 })), [2, 3]);
  assert.deepEqual(pagesInWave(4, 4, baseCfg({ concurrency: 2 })), [4]);
});

test("pagesInWave: empty once the wave starts past last_page", () => {
  assert.deepEqual(pagesInWave(4, 3, baseCfg({ concurrency: 2 })), []);
});

test("pagesInWave: clamps to maxPages on both sides", () => {
  assert.deepEqual(
    pagesInWave(5, Infinity, baseCfg({ maxPages: 6, concurrency: 3 })),
    [5, 6],
  );
  assert.deepEqual(
    pagesInWave(7, Infinity, baseCfg({ maxPages: 6, concurrency: 3 })),
    [],
  );
});
