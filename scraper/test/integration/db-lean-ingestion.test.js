"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/db");
const { ensureSchema, needsDb } = require("../helpers/db");

let db;

test.before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  db = new Db(process.env.TEST_DATABASE_URL);
  await db.waitUntilReady();
  await ensureSchema(db.pool);
});

test.after(async () => {
  if (db) await db.close();
});

test.beforeEach(async () => {
  if (!db) return;
  await db.pool.query(
    "TRUNCATE lean.price_history, lean.listings, lean.scrape_runs, lean.saved_searches RESTART IDENTITY CASCADE",
  );
});

const SEARCH_A = {
  searchKey: "/pretraga?category_id=23",
  name: "Apartments",
  url: "https://olx.ba/pretraga?category_id=23",
  category: "apartments",
};
const SEARCH_B = {
  searchKey: "/pretraga?category_id=26",
  name: "Houses",
  url: "https://olx.ba/pretraga?category_id=26",
  category: "houses",
};

function card(articleId, price = 100000) {
  return {
    articleId,
    url: `https://olx.ba/artikal/${articleId}/example`,
    title: `Listing ${articleId}`,
    sqm: 50,
    rooms: "2",
    price,
    pricePresent: true,
    isRent: false,
  };
}

async function commit(search, cards) {
  await db.registerSavedSearch(search);
  const runId = await db.startRun(search.searchKey);
  await db.commitSearchIngestion({
    runId,
    search,
    cards,
    membership: {
      searchKey: search.searchKey,
      articleIds: cards.map((row) => row.articleId),
    },
    run: { status: "ok", isComplete: true, pages: 1, cards: cards.length },
  });
  return runId;
}

async function listing(articleId) {
  const { rows } = await db.pool.query(
    `SELECT search_keys, price, deal, closed_at, closing_price
       FROM lean.listings WHERE article_id = $1`,
    [articleId],
  );
  return rows[0];
}

needsDb(
  "lean membership drops only the search that stopped returning a listing",
  async () => {
    await commit(SEARCH_A, [card(9101)]);
    await commit(SEARCH_B, [card(9101)]);
    assert.deepEqual(
      (await listing(9101)).search_keys.slice().sort(),
      [SEARCH_A.searchKey, SEARCH_B.searchKey].sort(),
    );

    await commit(SEARCH_A, []);
    const shared = await listing(9101);
    assert.deepEqual(shared.search_keys, [SEARCH_B.searchKey]);
    assert.equal(shared.closed_at, null);

    await commit(SEARCH_B, []);
    const closed = await listing(9101);
    assert.deepEqual(closed.search_keys, []);
    assert.ok(closed.closed_at);
    assert.equal(closed.closing_price, "100000.00");
  },
);

needsDb(
  "lean price history keeps one search price per local date",
  async () => {
    await commit(SEARCH_A, [card(9102, 100000)]);
    await commit(SEARCH_A, [card(9102, 100000)]);
    await commit(SEARCH_A, [card(9102, 90000)]);
    await commit(SEARCH_A, [card(9102, 90000)]);

    const row = await listing(9102);
    assert.equal(row.price, "90000.00");
    assert.equal(row.deal, "sale");
    const history = await db.pool.query(
      "SELECT price, source FROM lean.price_history WHERE article_id = $1 ORDER BY id",
      [9102],
    );
    assert.deepEqual(history.rows, [{ price: "90000.00", source: "search" }]);
  },
);

needsDb(
  "lean neighborhood keeps an exact known source location ahead of pin fallback",
  async () => {
    await commit(SEARCH_A, [card(9107)]);
    await db.pool.query(
      `UPDATE lean.listings
          SET latitude=44.7839172,longitude=17.1629606,
              extra=extra || '{"location":"Laus 2"}'::jsonb
        WHERE article_id=9107`,
    );
    await commit(SEARCH_A, [card(9107)]);
    const result = await db.pool.query(
      "SELECT neighborhood FROM lean.listings WHERE article_id=9107",
    );
    assert.equal(result.rows[0].neighborhood, "Laus 2");
  },
);

needsDb("lean records each scrape page manifest", async () => {
  await db.registerSavedSearch(SEARCH_A);
  const runId = await db.startRun(SEARCH_A.searchKey);
  await db.recordScrapePageManifest({
    runId,
    pageNumber: 1,
    requestUrl: "https://olx.ba/api/search?page=1",
    responseState: "malformed",
    expectedTotal: 3,
    expectedLastPage: 1,
    responsePage: 1,
    rawItemCount: 2,
    parsedItemCount: 1,
    duplicateItemCount: 1,
    parseRejections: [{ reason: "invalid_title" }],
    error: "one item rejected",
  });
  await db.recordScrapePageManifest({
    runId,
    pageNumber: 2,
    requestUrl: "https://olx.ba/api/search?page=2",
    responseState: "ok",
    expectedTotal: 2,
    expectedLastPage: 1,
    responsePage: 1,
    responsePerPage: 40,
    rawItemCount: 2,
    parsedItemCount: 2,
    isAuthoritative: true,
  });
  const pages = await db.pool.query(
    `SELECT page_number,response_state,parse_rejection_count,is_authoritative
       FROM lean.scrape_run_pages WHERE run_id=$1 ORDER BY page_number`,
    [runId],
  );
  assert.deepEqual(pages.rows, [
    {
      page_number: 1,
      response_state: "malformed",
      parse_rejection_count: 1,
      is_authoritative: false,
    },
    {
      page_number: 2,
      response_state: "ok",
      parse_rejection_count: 0,
      is_authoritative: true,
    },
  ]);
  const diagnostics = await db.pool.query(
    `SELECT count(*)::int AS count FROM lean.raw_api_responses
      WHERE run_id=$1 AND diagnostic->>'kind'='page_manifest'`,
    [runId],
  );
  assert.equal(diagnostics.rows[0].count, 1);
});

needsDb("lean closure is stable until a listing reappears", async () => {
  await commit(SEARCH_A, [card(9103, 125000)]);
  await commit(SEARCH_A, []);
  const firstClosure = await listing(9103);
  assert.ok(firstClosure.closed_at);
  assert.equal(firstClosure.closing_price, "125000.00");

  await db.closeUnseenListings([SEARCH_A.searchKey]);
  const stillClosed = await listing(9103);
  assert.deepEqual(stillClosed.closed_at, firstClosure.closed_at);
  assert.equal(stillClosed.closing_price, firstClosure.closing_price);

  await commit(SEARCH_A, [card(9103, 120000)]);
  const reopened = await listing(9103);
  assert.deepEqual(reopened.search_keys, [SEARCH_A.searchKey]);
  assert.equal(reopened.closed_at, null);
  assert.equal(reopened.closing_price, null);
  assert.equal(reopened.price, "120000.00");

  await commit(SEARCH_A, []);
  const events = await db.pool.query(
    `SELECT event_type, price, opened_at, occurred_at
       FROM lean.listing_lifecycle_events
      WHERE article_id = $1 ORDER BY occurred_at, id`,
    [9103],
  );
  assert.deepEqual(
    events.rows.map((event) => event.event_type),
    ["closed", "reopened", "closed"],
  );
  assert.deepEqual(
    events.rows.map((event) => event.price),
    ["125000.00", "120000.00", "120000.00"],
  );
  assert.ok(events.rows[0].opened_at);
  assert.deepEqual(events.rows[2].opened_at, events.rows[1].occurred_at);
});

needsDb("lean global closure records an exit only once", async () => {
  await commit(SEARCH_A, [card(9105)]);
  await db.closeUnseenListings([SEARCH_B.searchKey]);
  await db.closeUnseenListings([SEARCH_B.searchKey]);
  const events = await db.pool.query(
    `SELECT event_type FROM lean.listing_lifecycle_events
      WHERE article_id = $1`,
    [9105],
  );
  assert.deepEqual(events.rows, [{ event_type: "closed" }]);
});

needsDb(
  "lean history keeps the latest reported price per Banja Luka day",
  async () => {
    await commit(SEARCH_A, [card(9106, 125000)]);
    const earlier = Math.floor(Date.parse("2025-04-01T02:00:00Z") / 1000);
    const later = Math.floor(Date.parse("2025-04-01T18:00:00Z") / 1000);
    await db.enrichListings([
      {
        articleId: 9106,
        dealType: "sale",
        price: 124000,
        sqm: 60,
        apiPriceHistory: [
          { date: earlier, price: 126000 },
          { date: later, price: 124000 },
        ],
      },
    ]);
    const prices = await db.pool.query(
      `SELECT to_char(price_date,'YYYY-MM-DD') AS price_date,price,source
         FROM lean.price_history
      WHERE article_id=9106 AND source='api_price_history'`,
    );
    assert.deepEqual(prices.rows, [
      {
        price_date: "2025-04-01",
        price: "124000.00",
        source: "api_price_history",
      },
    ]);
  },
);

needsDb(
  "lean ingestion rolls back every write when finishing a run fails",
  async () => {
    await db.registerSavedSearch(SEARCH_A);
    const runId = await db.startRun(SEARCH_A.searchKey);
    await db.pool.query(`CREATE FUNCTION lean.test_reject_run_finish()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status <> 'running' THEN
        RAISE EXCEPTION 'forced test failure';
      END IF;
      RETURN NEW;
    END $$`);
    await db.pool.query(`CREATE TRIGGER test_reject_run_finish
    BEFORE UPDATE ON lean.scrape_runs
    FOR EACH ROW EXECUTE FUNCTION lean.test_reject_run_finish()`);
    try {
      await assert.rejects(
        db.commitSearchIngestion({
          runId,
          search: SEARCH_A,
          cards: [card(9104)],
          membership: { searchKey: SEARCH_A.searchKey, articleIds: [9104] },
          run: { status: "ok", isComplete: true, pages: 1, cards: 1 },
        }),
        /forced test failure/,
      );
      assert.equal(await listing(9104), undefined);
      const history = await db.pool.query(
        "SELECT count(*)::int AS n FROM lean.price_history WHERE article_id = 9104",
      );
      assert.equal(history.rows[0].n, 0);
      const run = await db.pool.query(
        "SELECT status, finished_at FROM lean.scrape_runs WHERE id = $1",
        [runId],
      );
      assert.equal(run.rows[0].status, "running");
      assert.equal(run.rows[0].finished_at, null);
    } finally {
      await db.pool.query(
        "DROP TRIGGER IF EXISTS test_reject_run_finish ON lean.scrape_runs",
      );
      await db.pool.query(
        "DROP FUNCTION IF EXISTS lean.test_reject_run_finish()",
      );
    }
  },
);
