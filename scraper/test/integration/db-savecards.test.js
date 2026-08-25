"use strict";
// Integration tests for Db.saveCards write semantics: upsert + last_seen bump,
// history appended only when ppm² is known AND something changed, drops
// counted on decreases.
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
const historyCount = (id) =>
  db.pool
    .query(
      "SELECT count(*)::int AS n FROM price_history WHERE article_id = $1",
      [id],
    )
    .then((r) => r.rows[0].n);

needsDb(
  "saveCards: first sighting inserts listing + initial history snapshot",
  async () => {
    const r = await db.saveCards([card()]);
    assert.deepEqual(
      { new: r.newCount, drop: r.dropCount },
      { new: 1, drop: 0 },
    );
    const [row] = await listingRows();
    assert.equal(Number(row.article_id), 3001); // pg returns BIGINT as string
    assert.equal(Number(row.price), 100000);
    assert.equal(row.ppm2, 2000);
    assert.equal(await historyCount(3001), 1);
  },
);

needsDb(
  "saveCards: price drop appends history and counts the drop",
  async () => {
    await db.saveCards([card()]);
    const r = await db.saveCards([
      card({ price: 90000, priceText: "90.000 KM", ppm2: 1800 }),
    ]);
    assert.equal(r.dropCount, 1);
    assert.equal(await historyCount(3001), 2);
    const [row] = await listingRows();
    assert.equal(Number(row.price), 90000);
    assert.equal(row.ppm2, 1800);
  },
);
needsDb("saveCards: unchanged snapshot appends nothing", async () => {
  await db.saveCards([card()]);
  await db.saveCards([card()]);
  const r = await db.saveCards([card()]);
  assert.deepEqual({ new: r.newCount, drop: r.dropCount }, { new: 0, drop: 0 });
  assert.equal(await historyCount(3001), 1);
});

needsDb(
  "saveCards: snapshot that lost its price never appends history",
  async () => {
    await db.saveCards([card()]);
    const r = await db.saveCards([
      card({ price: null, priceText: "Na upit", ppm2: null }),
    ]);
    assert.equal(r.dropCount, 0); // gate: card.ppm2 must be known
    assert.equal(await historyCount(3001), 1);
    const [row] = await listingRows();
    assert.equal(row.price, null);
    assert.equal(row.ppm2, null);
  },
);

needsDb(
  "saveCards: rent cards are tracked but never yield ppm²/history updates",
  async () => {
    await db.saveCards([
      card({
        url: "https://olx.ba/artikal/3002/b",
        title: "Stan iznajmljivanje",
        price: 400,
        priceText: "400 KM",
        ppm2: null,
        isRent: true,
      }),
    ]);
    assert.equal(await historyCount(3002), 1); // initial insert only
    const r = await db.saveCards([
      card({
        url: "https://olx.ba/artikal/3002/b",
        title: "Stan iznajmljivanje",
        price: 450,
        priceText: "450 KM",
        ppm2: null,
        isRent: true,
      }),
    ]);
    assert.equal(r.dropCount, 0); // gate: ppm² unknown
    assert.equal(await historyCount(3002), 1);
  },
);

needsDb(
  "saveCards: cards without an extractable article id are ignored",
  async () => {
    const r = await db.saveCards([
      { ...card(), url: "https://olx.ba/pretraga?kat=16" },
    ]);
    assert.equal(r.newCount, 0);
    assert.equal((await listingRows()).length, 0);
  },
);
