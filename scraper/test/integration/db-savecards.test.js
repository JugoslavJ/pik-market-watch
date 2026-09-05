"use strict";
// Integration tests for the atomic search-ingestion boundary: current rows,
// canonical price evidence, membership, lifecycle counters and rollback.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;

test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(() => reset(db.pool));

const card = (over) =>
  Object.assign(
    {
      url: "https://olx.ba/artikal/3001/a",
      title: "Stan 50m2",
      sqm: 50,
      rooms: "2",
      price: 100000,
      priceText: "100.000 KM",
      ppm2: 2000,
      isRent: false,
    },
    over,
  );

const listingRows = () =>
  db.pool
    .query("SELECT article_id, price, ppm2 FROM listings ORDER BY article_id")
    .then((r) => r.rows);
const eventRows = (id) =>
  db.pool
    .query(
      `SELECT effective_at, price, price_state
         FROM listing_price_events
        WHERE article_id = $1
        ORDER BY effective_at, id`,
      [id],
    )
    .then((r) => r.rows);

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

const priceEvent = (row, observedAt) => ({
  articleId: row.articleId,
  effectiveAt: observedAt,
  ingestedAt: observedAt,
  price: row.price,
  priceState: row.priceState ?? (row.price == null ? "unpriced" : "valid"),
  dealType: row.isRent ? "rent" : "sale",
  source: "search",
  isCurrent: true,
  provenance: { observation: "search_card" },
});

const commit = async (
  cards,
  {
    search = SEARCH_A,
    observedAt = new Date(),
    priceEvents = cards.map((row) => priceEvent(row, observedAt)),
  } = {},
) => {
  await db.registerSavedSearch(search);
  const runId = await db.startRun(search.searchKey);
  return db.commitSearchIngestion({
    runId,
    search,
    cards,
    priceEvents,
    membership: {
      searchKey: search.searchKey,
      articleIds: cards.map((row) => row.articleId),
    },
    run: { status: "ok", isComplete: true, pages: 1, cards: cards.length },
    analytics: { invalidateFrom: observedAt },
  });
};

needsDb(
  "commitSearchIngestion returns counters for new and dropped listings",
  async () => {
    const first = card({ articleId: 3001 });
    const second = card({
      articleId: 3001,
      price: 90000,
      priceText: "90.000 KM",
      ppm2: 1800,
    });
    assert.deepEqual(await commit([first]), {
      newCount: 1,
      dropCount: 0,
      newIds: [3001],
    });
    assert.deepEqual(await commit([second]), {
      newCount: 0,
      dropCount: 1,
      newIds: [],
    });
    const saved = await db.pool.query(
      "SELECT new_count, drop_count FROM saved_searches WHERE search_key = $1",
      [SEARCH_A.searchKey],
    );
    assert.deepEqual(saved.rows[0], { new_count: 0, drop_count: 1 });
  },
);

needsDb(
  "commitSearchIngestion preserves explicit unpriced and rent boundaries",
  async () => {
    const unpriced = card({
      articleId: 3003,
      price: null,
      priceText: "Na upit",
      ppm2: null,
      pricePresent: false,
    });
    const rent = card({
      articleId: 3004,
      price: 400,
      priceText: "400 KM",
      ppm2: null,
      isRent: true,
    });
    const result = await commit([unpriced, rent]);
    assert.equal(result.newCount, 2);
    const rows = await db.pool.query(
      "SELECT article_id, price, ppm2, is_rent FROM listings WHERE article_id IN (3003, 3004) ORDER BY article_id",
    );
    assert.deepEqual(
      rows.rows.map((row) => ({
        id: Number(row.article_id),
        price: row.price,
        ppm2: row.ppm2,
        rent: row.is_rent,
      })),
      [
        { id: 3003, price: null, ppm2: null, rent: false },
        { id: 3004, price: "400.00", ppm2: null, rent: true },
      ],
    );
  },
);

needsDb("commitSearchIngestion rolls back a mid-write failure", async () => {
  await db.registerSavedSearch({
    searchKey: "/pretraga?category_id=23",
    name: "Apartments",
    url: "https://olx.ba/pretraga?category_id=23",
    category: "apartments",
  });
  const runId = await db.startRun("/pretraga?category_id=23");
  await assert.rejects(
    db.commitSearchIngestion({
      runId,
      search: {
        searchKey: "/pretraga?category_id=23",
        name: "Apartments",
        url: "https://olx.ba/pretraga?category_id=23",
        category: "apartments",
      },
      cards: [card({ articleId: 3005 })],
      stateObservations: [
        {
          articleId: 3005,
          effectiveAt: new Date(),
          source: "search",
          eventType: "not-a-real-event",
        },
      ],
      membership: { searchKey: "/pretraga?category_id=23", articleIds: [3005] },
      run: { status: "ok", isComplete: true, pages: 1, cards: 1 },
    }),
  );
  const row = await db.pool.query(
    "SELECT 1 FROM listings WHERE article_id = 3005",
  );
  assert.equal(row.rowCount, 0);
});

needsDb(
  "commitSearchIngestion canonicalizes equal-time competing evidence",
  async () => {
    const observedAt = new Date("2026-09-05T12:00:00Z");
    await db.registerSavedSearch({
      searchKey: "/pretraga?category_id=23",
      name: "Apartments",
      url: "https://olx.ba/pretraga?category_id=23",
      category: "apartments",
    });
    const runId = await db.startRun("/pretraga?category_id=23");
    await db.commitSearchIngestion({
      runId,
      search: {
        searchKey: "/pretraga?category_id=23",
        name: "Apartments",
        url: "https://olx.ba/pretraga?category_id=23",
        category: "apartments",
      },
      cards: [card({ articleId: 3006 })],
      priceEvents: [
        {
          articleId: 3006,
          effectiveAt: observedAt,
          price: 100000,
          priceState: "valid",
          source: "search",
          isCurrent: true,
        },
        {
          articleId: 3006,
          effectiveAt: observedAt,
          price: 90000,
          priceState: "valid",
          source: "search",
          isCurrent: true,
        },
      ],
      membership: { searchKey: "/pretraga?category_id=23", articleIds: [3006] },
      run: { status: "ok", isComplete: true, pages: 1, cards: 1 },
      analytics: { invalidateFrom: observedAt },
    });
    const rows = await db.pool.query(
      "SELECT price, price_state FROM listing_price_events WHERE article_id = 3006",
    );
    assert.deepEqual(rows.rows, [
      { price: "100000.00", price_state: "valid" },
      { price: null, price_state: "conflict" },
    ]);
  },
);

needsDb(
  "commitSearchIngestion stores the current row, membership and price evidence",
  async () => {
    const observedAt = new Date("2026-09-05T08:00:00Z");
    const result = await commit([card({ articleId: 3001 })], { observedAt });

    assert.deepEqual(result, {
      newCount: 1,
      dropCount: 0,
      newIds: [3001],
    });
    const [row] = await listingRows();
    assert.equal(Number(row.article_id), 3001);
    assert.equal(Number(row.price), 100000);
    assert.equal(row.ppm2, 2000);
    assert.deepEqual(await eventRows(3001), [
      {
        effective_at: observedAt,
        price: "100000.00",
        price_state: "valid",
      },
    ]);
    const membership = await db.pool.query(
      "SELECT article_id::int AS id FROM search_results WHERE search_key = $1",
      [SEARCH_A.searchKey],
    );
    assert.deepEqual(membership.rows, [{ id: 3001 }]);
  },
);

needsDb(
  "an existing listing joining a second search is not a new discovery",
  async () => {
    const observedAt = new Date("2026-09-05T08:15:00Z");
    await commit([card({ articleId: 3010 })], { observedAt });
    const result = await commit([card({ articleId: 3010 })], {
      search: SEARCH_B,
      observedAt,
    });

    assert.deepEqual(result, { newCount: 0, dropCount: 0, newIds: [] });
    const memberships = await db.pool.query(
      "SELECT search_key FROM search_results WHERE article_id = 3010 ORDER BY search_key",
    );
    assert.deepEqual(
      memberships.rows.map((row) => row.search_key),
      [SEARCH_A.searchKey, SEARCH_B.searchKey].sort(),
    );
  },
);

needsDb(
  "a same-timestamp ingestion retry does not duplicate canonical evidence",
  async () => {
    const observedAt = new Date("2026-09-05T08:30:00Z");
    const input = card({ articleId: 3011 });
    await commit([input], { observedAt });
    const retry = await commit([input], { observedAt });

    assert.deepEqual(retry, { newCount: 0, dropCount: 0, newIds: [] });
    assert.equal((await eventRows(3011)).length, 1);
  },
);

needsDb(
  "an explicit unpriced observation preserves the last known current price",
  async () => {
    const pricedAt = new Date("2026-09-05T09:00:00Z");
    const unpricedAt = new Date("2026-09-05T10:00:00Z");
    await commit([card({ articleId: 3012 })], { observedAt: pricedAt });
    const result = await commit(
      [
        card({
          articleId: 3012,
          price: null,
          priceText: "Na upit",
          ppm2: null,
          pricePresent: false,
          priceState: "unpriced",
        }),
      ],
      { observedAt: unpricedAt },
    );

    assert.equal(result.dropCount, 0);
    const [row] = await listingRows();
    assert.equal(Number(row.price), 100000);
    assert.equal(row.ppm2, 2000);
    assert.deepEqual(
      (await eventRows(3012)).map((event) => ({
        price: event.price,
        state: event.price_state,
      })),
      [
        { price: "100000.00", state: "valid" },
        { price: null, state: "unpriced" },
      ],
    );
  },
);

needsDb("rent observations remain priced without deriving ppm²", async () => {
  const observedAt = new Date("2026-09-05T10:30:00Z");
  const result = await commit(
    [
      card({
        articleId: 3013,
        title: "Stan iznajmljivanje",
        price: 400,
        priceText: "400 KM",
        ppm2: null,
        isRent: true,
      }),
    ],
    { observedAt },
  );

  assert.equal(result.newCount, 1);
  const [row] = await listingRows();
  assert.equal(Number(row.price), 400);
  assert.equal(row.ppm2, null);
  assert.deepEqual(await eventRows(3013), [
    {
      effective_at: observedAt,
      price: "400.00",
      price_state: "valid",
    },
  ]);
});

needsDb("cards without a supported article id are ignored", async () => {
  const result = await commit([card({ articleId: null })]);
  assert.deepEqual(result, { newCount: 0, dropCount: 0, newIds: [] });
  assert.equal((await listingRows()).length, 0);
});
