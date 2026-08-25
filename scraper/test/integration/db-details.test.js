"use strict";
// Integration tests for detail-page enrichment (05/06 migrations): attribute
// persistence, first-wins scalar semantics, JSONB merge, the details_fetched_at
// stamp, pending-detail queries and the analytics views.
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

const KEY_A = "/pretraga?category_id=23";
const KEY_B = "/pretraga?category_id=26";

async function register(key, category) {
  await db.registerSavedSearch({
    searchKey: key,
    name: "search " + key,
    url: "https://olx.ba" + key,
    category,
  });
}

async function seed(articleId, over = {}, key = KEY_A) {
  await register(key, "apartments");
  await db.saveCards([
    {
      url: `https://olx.ba/artikal/${articleId}/x`,
      title: "ad " + articleId,
      sqm: null,
      rooms: "2",
      isRent: false,
      price: 100000,
      priceText: "",
      ppm2: null,
      ...over,
    },
  ]);
  await db.refreshSearchResults(key, [articleId]);
}

const rowOf = async (id) =>
  (await db.pool.query("SELECT * FROM listings WHERE article_id = $1", [id]))
    .rows[0];

needsDb(
  "enrichListings persists every detail fact and stamps the visit",
  async () => {
    await seed(7001);
    await db.enrichListings([
      {
        articleId: 7001,
        latitude: 44.812345,
        longitude: 17.198765,
        sqm: 40,
        publishedAt: new Date("2025-03-01T10:30:00Z"),
        renewedAt: new Date("2025-06-15T08:00:00Z"),
        sellerType: "shop",
        roomsDetail: "Dvosoban",
        bathrooms: 2,
        floorNum: -1,
        floorsTotal: 6,
        unitLevels: 2,
        heating: "Centralno (gradsko)",
        furnished: true,
        condition: "Novogradnja",
        parking: true,
        garage: false,
        elevator: true,
        yearBuilt: 2019,
        plotSqm: 500.5,
        orientation: "Jug",
        views: 1234,
        favorites: 7,
        characteristics: { kvadrata: 40, "broj-soba": 2 },
      },
    ]);
    const r = await rowOf(7001);
    assert.equal(r.latitude, 44.812345);
    assert.deepEqual(r.published_at, new Date("2025-03-01T10:30:00Z"));
    assert.deepEqual(r.renewed_at, new Date("2025-06-15T08:00:00Z"));
    assert.equal(r.seller_type, "shop");
    assert.equal(r.rooms_detail, "Dvosoban");
    assert.equal(r.bathrooms, 2);
    assert.equal(r.floor_num, -1);
    assert.equal(r.floors_total, 6);
    assert.equal(r.unit_levels, 2);
    assert.equal(r.heating, "Centralno (gradsko)");
    assert.equal(r.furnished, true);
    assert.equal(r.condition, "Novogradnja");
    assert.equal(r.parking, true);
    assert.equal(r.garage, false);
    assert.equal(r.elevator, true);
    assert.equal(r.year_built, 2019);
    assert.equal(Number(r.plot_sqm), 500.5);
    assert.equal(r.orientation, "Jug");
    assert.equal(r.views, 1234);
    assert.equal(r.favorites, 7);
    assert.ok(r.details_fetched_at);
    // learned m² on a priced sale ad derives ppm² (100000 / 40):
    assert.equal(Number(r.sqm), 40);
    assert.equal(r.ppm2, 2500);
  },
);

needsDb(
  "scalars are first-wins; renewed_at moves forward; characteristics merge",
  async () => {
    await seed(7002);
    await db.enrichListings([
      {
        articleId: 7002,
        heating: "Struja",
        publishedAt: new Date("2024-01-01T00:00:00Z"),
        renewedAt: new Date("2025-01-01T00:00:00Z"),
        views: 100,
        characteristics: { kvadrata: 55 },
      },
    ]);
    const stampedOnce = (await rowOf(7002)).details_fetched_at;
    await db.enrichListings([
      {
        articleId: 7002,
        heating: "Plin",
        publishedAt: new Date("2026-08-21T15:09:00Z"),
        renewedAt: new Date("2025-06-01T00:00:00Z"),
        views: 9999,
        characteristics: { lift: "Da" },
      },
    ]);
    const r = await rowOf(7002);
    assert.equal(r.heating, "Struja"); // never overwritten
    assert.deepEqual(r.published_at, new Date("2024-01-01T00:00:00Z"));
    assert.deepEqual(r.renewed_at, new Date("2025-06-01T00:00:00Z")); // moved FORWARD
    assert.equal(r.views, 100);
    assert.deepEqual(r.characteristics, { kvadrata: 55, lift: "Da" }); // merged
    assert.ok(r.details_fetched_at.getTime() >= stampedOnce.getTime());
  },
);

needsDb(
  "enrichListings stamps the neighborhood from map pins; first-wins",
  async () => {
    await seed(7010);
    // Trg Krajine area -> inside the Centar 2 MZ polygon (11-neighborhoods.sql):
    await db.enrichListings([
      {
        articleId: 7010,
        latitude: 44.7725,
        longitude: 17.1905,
        characteristics: {},
      },
    ]);
    assert.equal((await rowOf(7010)).location, "Centar 2");
    // A pin outside every district leaves location empty:
    await seed(7011);
    await db.enrichListings([
      { articleId: 7011, latitude: 44.9, longitude: 17.5, characteristics: {} },
    ]);
    assert.equal((await rowOf(7011)).location, null);
    // First-wins: a later pass with a different pin never re-labels (the second
    // pin at 44.7940/17.2000 would map to Petricevac, but 7010 keeps its value).
    await db.enrichListings([
      {
        articleId: 7010,
        latitude: 44.794,
        longitude: 17.2,
        characteristics: {},
      },
    ]);
    assert.equal((await rowOf(7010)).location, "Centar 2");
  },
);

needsDb(
  "enrichmentQueue: never-attempted first, then oldest attempt, capped",
  async () => {
    await seed(7101);
    await seed(7102);
    await seed(7103); // all three lack pin + m² + a detail visit

    const firstPass = await db.enrichmentQueue([7101, 7102, 7103], 2);
    assert.deepEqual(
      firstPass.pending.map((p) => p.id),
      [7101, 7102],
    ); // NULLS FIRST → id order
    assert.equal(firstPass.total, 3); // backlog size reported beyond the cap
    assert.equal(firstPass.pending[0].unpinned, true);
    assert.equal(firstPass.pending[0].missingSqm, true);
    assert.equal(firstPass.pending[0].neverDetailed, true);

    // Attempting 7101 rotates it behind the untouched rows…
    await db.enrichListings([{ articleId: 7101, characteristics: {} }]);
    const secondPass = await db.enrichmentQueue([7101, 7102, 7103], 5);
    assert.deepEqual(
      secondPass.pending.map((p) => p.id),
      [7102, 7103, 7101],
    );
  },
);

needsDb(
  "enrichmentQueue: skips closed rows; empty when nothing is pending",
  async () => {
    await seed(7104);
    await db.enrichListings([
      {
        articleId: 7104,
        latitude: 44.9,
        longitude: 17.3,
        sqm: 50,
        characteristics: {},
      },
    ]); // fully enriched
    const q = await db.enrichmentQueue([7104], 25);
    assert.deepEqual(q.pending, []);
    assert.equal(q.total, 0);
  },
);

needsDb(
  "getListingsNeedingDetails includes rows never detail-fetched",
  async () => {
    await seed(7005, { sqm: 50, price: 100000, priceText: "", ppm2: 2000 }); // sqm complete
    assert.equal(
      (await db.getListingsNeedingDetails(true)).filter(
        (t) => Number(t.articleId) === 7005,
      ).length,
      1,
    );
    // Pin + stamp together — with both present the row leaves the queue:
    await db.enrichListings([
      { articleId: 7005, latitude: 44.9, longitude: 17.3, characteristics: {} },
    ]);
    assert.equal(
      (await db.getListingsNeedingDetails(true)).filter(
        (t) => Number(t.articleId) === 7005,
      ).length,
      0,
    );
  },
);

needsDb("v_listing_lifecycle exposes opening/closing economics", async () => {
  await register(KEY_A, "apartments");
  await seed(7006, { sqm: 50, price: 100000, priceText: "", ppm2: 2000 });
  await db.saveCards([
    {
      url: "https://olx.ba/artikal/7006/x",
      title: "ad 7006 cut",
      sqm: 50,
      rooms: "2",
      isRent: false,
      price: 90000,
      priceText: "",
      ppm2: 1800,
    },
  ]); // change → history row
  await db.refreshSearchResults(KEY_A, [7006]);
  await db.refreshSearchResults(KEY_A, []);
  await db.closeUnseenListings([KEY_A]);

  const lc = (
    await db.pool.query(
      "SELECT * FROM v_listing_lifecycle WHERE article_id = 7006",
    )
  ).rows[0];
  assert.equal(Number(lc.opening_price), 100000);
  assert.equal(Number(lc.last_history_price), 90000);
  assert.equal(lc.n_changes, 2);
  assert.equal(Number(lc.closing_price), 90000);
  assert.equal(lc.is_closed, true);
  assert.equal(lc.category, "apartments");
  assert.equal(typeof lc.days_listed, "number");
  assert.ok(lc.days_listed >= 0);

  // Active listings still appear through the view, flagged open:
  await seed(7007);
  const lc7 = (
    await db.pool.query(
      "SELECT is_closed FROM v_listing_lifecycle WHERE article_id = 7007",
    )
  ).rows[0];
  assert.equal(lc7.is_closed, false);
});

needsDb(
  "v_market_daily sums births/deaths and tracks live inventory",
  async () => {
    await seed(7008); // will be closed below
    await seed(7009, {}, KEY_B); // stays open
    await db.refreshSearchResults(KEY_A, []);
    await db.closeUnseenListings([KEY_A, KEY_B]);

    const daily = (
      await db.pool.query("SELECT * FROM v_market_daily ORDER BY day")
    ).rows;
    assert.ok(daily.length >= 1);
    assert.equal(
      daily.reduce((s, r) => s + r.new_n, 0),
      2,
    );
    assert.equal(
      daily.reduce((s, r) => s + r.closed_n, 0),
      1,
    );
    assert.equal(daily[daily.length - 1].active_est, 1);
  },
);
