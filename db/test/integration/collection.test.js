"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { needsDb, setupDb, reset } = require("../helpers/db");
const { collectSearch } = require("../../../collector/src/collection");
const { mapListingDetail } = require("../../../collector/src/payload-mapper");

let db;
test.before(async () => {
  if (process.env.TEST_DATABASE_URL) db = await setupDb();
});
test.beforeEach(async () => {
  if (db) await reset(db.pool);
});
test.after(async () => {
  await db?.close();
});

const search = {
  name: "Fresh search",
  searchKey: "collection-audit",
  url: "https://olx.ba/pretraga?category_id=23",
  category: "apartments",
};
const cfg = {
  maxPages: 10,
  concurrency: 2,
  pageDelayMs: 0,
  perPage: 40,
  apiTimeoutMs: 100,
  maxDetailFetches: 0,
};
const item = (id, extra = {}) => ({
  id,
  title: `Apartment ${id}`,
  price: 150000,
  display_price: "150000 KM",
  listing_type: "sell",
  ...extra,
});
function collect(items, total = items.length, extra = {}) {
  return collectSearch(db, search, { ...cfg, ...extra.cfg }, () => {}, {
    fetchSearchPage: async () => ({
      items,
      meta: { total, last_page: 1, current_page: 1 },
    }),
    pace: async () => {},
    ...extra.deps,
  });
}

needsDb(
  "first collection registers a new search and commits its run",
  async () => {
    const result = await collect([item(101)]);
    assert.equal(result.cards, 1);
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT status,is_complete,cards FROM lean.scrape_runs",
        )
      ).rows,
      [{ status: "ok", is_complete: true, cards: 1 }],
    );
    assert.equal(
      (await db.pool.query("SELECT count(*)::int AS n FROM lean.listings"))
        .rows[0].n,
      1,
    );
  },
);

needsDb(
  "short final page preserves membership and prices until an authoritative scrape",
  async () => {
    await collect([item(101), item(102)]);
    await assert.rejects(
      collect([item(101, { price: 120000 })], 2),
      /result count/,
    );
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT article_id::int AS id,price::int,closed_at FROM lean.listings ORDER BY article_id",
        )
      ).rows,
      [
        { id: 101, price: 150000, closed_at: null },
        { id: 102, price: 150000, closed_at: null },
      ],
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM lean.listing_lifecycle_events",
        )
      ).rows[0].n,
      0,
    );
    const run = (
      await db.pool.query(
        "SELECT status,is_complete FROM lean.scrape_runs ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
    assert.deepEqual(run, { status: "error", is_complete: false });
    await collect([item(101)]);
    assert.equal(
      (
        await db.pool.query(
          "SELECT closed_at IS NOT NULL AS closed FROM lean.listings WHERE article_id=102",
        )
      ).rows[0].closed,
      true,
    );
  },
);

needsDb(
  "source deal and currency evidence survives collection and detail persistence",
  async () => {
    await collect([
      item(101, { listing_type: undefined, display_price: undefined }),
      item(102, { currency: "EUR", display_price: "150000 EUR" }),
      item(103, { currency: "EUR" }),
    ]);
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT article_id::int AS id,deal,currency FROM lean.listings ORDER BY article_id",
        )
      ).rows,
      [
        { id: 101, deal: "unknown", currency: "unknown" },
        { id: 102, deal: "sale", currency: "EUR" },
        { id: 103, deal: "sale", currency: "conflict" },
      ],
    );
    const detail = mapListingDetail({
      ...item(102),
      currency: "EUR",
      display_price: "150000 EUR",
      price_history: [
        { date: 1700000000, price: 160000 },
        { date: 1700086400, price: 155000, currency: "BAM" },
      ],
    });
    await db.enrichListings([detail]);
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT price::int,currency FROM lean.price_history WHERE article_id=102 ORDER BY price_date",
        )
      ).rows,
      [
        { price: 160000, currency: "unknown" },
        { price: 155000, currency: "BAM" },
      ],
    );
  },
);
