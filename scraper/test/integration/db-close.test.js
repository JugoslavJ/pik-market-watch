"use strict";
// Integration tests for listing closure: ads that vanish from every
// configured search get closed with their last price recorded, and can
// reopen if they ever reappear.
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

async function seenVia(key, articleId, over = {}) {
  await db.registerSavedSearch({
    searchKey: key,
    name: "search " + key,
    url: "https://olx.ba" + key,
    category: "apartments",
  });
  const card = {
    url: `https://olx.ba/artikal/${articleId}/x`,
    title: "ad " + articleId,
    sqm: 50,
    rooms: "2",
    isRent: false,
    price: 100000,
    priceText: "100.000 KM",
    ppm2: 2000,
    ...over,
  };
  await db.saveCards([card]);
  await db.refreshSearchResults(key, [articleId]);
}
const rowOf = async (id) =>
  (
    await db.pool.query(
      "SELECT closed_at, closing_price::text AS closing_price, closing_ppm2, price, closing_category FROM listings WHERE article_id = $1",
      [id],
    )
  ).rows[0];

needsDb("listings returned by a live search are never closed", async () => {
  await seenVia(KEY_A, 6001);
  const n = await db.closeUnseenListings([KEY_A]);
  assert.equal(n, 0);
  assert.equal((await rowOf(6001)).closed_at, null);
});

needsDb("a vanished ad closes with its last price recorded", async () => {
  await seenVia(KEY_A, 6002, { price: 95000, ppm2: 1900 });
  // Next cycle: the search no longer returns it.
  await db.refreshSearchResults(KEY_A, []);
  const n = await db.closeUnseenListings([KEY_A]);
  assert.equal(n, 1);
  const r = await rowOf(6002);
  assert.ok(r.closed_at);
  assert.equal(r.closing_price, "95000.00");
  assert.equal(r.closing_ppm2, 1900);
});

needsDb("closure freezes closing_category; reopening clears it", async () => {
  await db.registerSavedSearch({
    searchKey: KEY_B,
    name: "search B",
    url: "https://olx.ba" + KEY_B,
    category: "houses",
  });
  await seenVia(KEY_A, 6010); // category apartments via KEY_A
  await db.refreshSearchResults(KEY_A, []); // last link gone → stamp
  await db.closeUnseenListings([KEY_A]);
  let r = await rowOf(6010);
  assert.ok(r.closed_at);
  assert.equal(r.closing_category, "apartments");

  // The frozen category survives while the raw row sits closed…
  await db.closeUnseenListings([KEY_A]);
  assert.equal((await rowOf(6010)).closing_category, "apartments");

  // …and is cleared when the ad reappears:
  await db.saveCards([
    {
      url: "https://olx.ba/artikal/6010/x",
      title: "back",
      sqm: 50,
      rooms: "2",
      price: 90000,
      priceText: "",
      ppm2: 1800,
      isRent: false,
    },
  ]);
  r = await rowOf(6010);
  assert.equal(r.closed_at, null);
  assert.equal(r.closing_category, null);
});

needsDb(
  "closure is idempotent — closing values are frozen, not refreshed",
  async () => {
    await seenVia(KEY_A, 6003);
    await db.refreshSearchResults(KEY_A, []);
    await db.closeUnseenListings([KEY_A]);
    const n = await db.closeUnseenListings([KEY_A]);
    assert.equal(n, 0); // already closed → untouched
    const r = await rowOf(6003);
    assert.ok(r.closed_at);
  },
);

needsDb("unpriced ads close too — with a NULL closing price", async () => {
  await seenVia(KEY_A, 6004, { price: null, priceText: "Na upit", ppm2: null });
  await db.refreshSearchResults(KEY_A, []);
  await db.closeUnseenListings([KEY_A]);
  const r = await rowOf(6004);
  assert.ok(r.closed_at);
  assert.equal(r.closing_price, null);
});

needsDb(
  "a listing shared by several searches stays open until all drop it",
  async () => {
    await db.registerSavedSearch({
      searchKey: KEY_B,
      name: "search B",
      url: "https://olx.ba" + KEY_B,
      category: "houses",
    });
    await seenVia(KEY_A, 6005);
    await db.saveCards([
      {
        url: "https://olx.ba/artikal/6005/x",
        title: "dup",
        sqm: 50,
        rooms: "2",
        price: 100000,
        priceText: "",
        ppm2: 2000,
        isRent: false,
      },
    ]);
    await db.refreshSearchResults(KEY_B, [6005]);

    await db.refreshSearchResults(KEY_A, []); // dropped from A only
    await db.closeUnseenListings([KEY_A, KEY_B]);
    assert.equal((await rowOf(6005)).closed_at, null);

    await db.refreshSearchResults(KEY_B, []); // now gone from both
    await db.closeUnseenListings([KEY_A, KEY_B]);
    assert.ok((await rowOf(6005)).closed_at);
  },
);

needsDb(
  "result links of deconfigured searches are purged and their listings closed",
  async () => {
    await seenVia(KEY_B, 6006); // KEY_B about to leave the config
    const n = await db.closeUnseenListings([KEY_A]); // config now only has KEY_A
    assert.equal(n, 1);
    const links = await db.pool.query(
      "SELECT count(*)::int AS n FROM search_results WHERE search_key = $1",
      [KEY_B],
    );
    assert.equal(links.rows[0].n, 0);
  },
);

needsDb(
  "an empty active-key list is refused (would close everything)",
  async () => {
    await seenVia(KEY_A, 6007);
    assert.equal(await db.closeUnseenListings([]), 0);
    assert.equal(await historyIntact(), true);
    async function historyIntact() {
      const r = await db.pool.query(
        "SELECT count(*)::int AS n FROM search_results WHERE search_key = $1",
        [KEY_A],
      );
      return r.rows[0].n === 1;
    }
  },
);

needsDb(
  "re-sighting a closed ad reopens it and clears closing values",
  async () => {
    await seenVia(KEY_A, 6008, { price: 90000 });
    await db.refreshSearchResults(KEY_A, []);
    await db.closeUnseenListings([KEY_A]);
    assert.ok((await rowOf(6008)).closed_at);

    // The ad reappears on olx.ba:
    await db.saveCards([
      {
        url: "https://olx.ba/artikal/6008/x",
        title: "back again",
        sqm: 50,
        rooms: "2",
        price: 88000,
        priceText: "88.000 KM",
        ppm2: 1760,
        isRent: false,
      },
    ]);
    const r = await rowOf(6008);
    assert.equal(r.closed_at, null);
    assert.equal(r.closing_price, null);
    assert.equal(Number(r.price), 88000);

    // …and it counts as active again:
    const v = await db.pool.query(
      "SELECT count(*)::int AS n FROM v_active_listings WHERE article_id = 6008",
    );
    assert.equal(v.rows[0].n, 1);
  },
);

needsDb(
  "closed listings disappear from v_active_listings immediately",
  async () => {
    await seenVia(KEY_A, 6009, { price: 70000, ppm2: 1400 });
    const before = await db.pool.query(
      "SELECT count(*)::int AS n FROM v_active_listings WHERE article_id = 6009",
    );
    assert.equal(before.rows[0].n, 1);

    await db.refreshSearchResults(KEY_A, []);
    await db.closeUnseenListings([KEY_A]);
    const after = await db.pool.query(
      "SELECT count(*)::int AS n FROM v_active_listings WHERE article_id = 6009",
    );
    assert.equal(after.rows[0].n, 0);

    // The raw row (with closing values) remains queryable for later analysis:
    const r = await rowOf(6009);
    assert.equal(r.closing_price, "70000.00");
    assert.equal(r.closing_ppm2, 1400);
  },
);
