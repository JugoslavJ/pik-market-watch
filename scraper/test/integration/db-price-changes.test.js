"use strict";

// Regression coverage for resolved price-change semantics.  A change is
// emitted only between adjacent valid observations in the same deal series;
// competing, invalid, and deal-transition evidence acts as a boundary.
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
test.beforeEach(async () => {
  await reset(db.pool);
});

async function listing(articleId) {
  await db.pool.query(
    `INSERT INTO listings (article_id, url, title, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $4)`,
    [
      articleId,
      `https://olx.ba/artikal/${articleId}`,
      `ad ${articleId}`,
      "2026-08-01T10:00:00Z",
    ],
  );
}

async function state(articleId, at, isRent = false) {
  await db.pool.query(
    `INSERT INTO listing_state_history
       (article_id, effective_at, source, event_type, is_rent,
        category, category_membership, sqm, rooms, filter_attributes,
        last_seen_at)
     VALUES ($1, $2, 'search', 'search_sighting', $3,
             'apartments', ARRAY['apartments'], 50, '2', '{}'::jsonb, $2)`,
    [articleId, at, isRent],
  );
}

async function price(
  articleId,
  at,
  value,
  priceState = "valid",
  source = "search",
) {
  await db.pool.query(
    `INSERT INTO listing_price_events
       (article_id, effective_at, observed_at, ingested_at, price,
        price_state, source, effective_at_basis)
     VALUES ($1, $2, $2, $2, $3, $4, $5, 'observed')`,
    [articleId, at, value, priceState, source],
  );
}

needsDb(
  "price changes resolve same-time competition and honor invalid boundaries",
  async () => {
    const articleId = 8901;
    await listing(articleId);
    await state(articleId, "2026-08-01T10:00:00Z");
    await price(articleId, "2026-08-01T10:00:00Z", 100000);
    await price(articleId, "2026-08-02T10:00:00Z", 90000, "valid", "search");
    await price(articleId, "2026-08-02T10:00:00Z", 80000, "valid", "detail");
    await price(articleId, "2026-08-02T10:00:00Z", null, "conflict", "detail");
    await price(articleId, "2026-08-03T10:00:00Z", 70000);
    await price(articleId, "2026-08-04T10:00:00Z", 60000);

    const rows = await db.pool.query(
      `SELECT effective_at, prior_price, price, delta, price_state
         FROM v_listing_price_changes
        WHERE article_id = $1
        ORDER BY effective_at`,
      [articleId],
    );
    assert.deepEqual(
      rows.rows.map((row) => ({
        effectiveAt: row.effective_at,
        prior: Number(row.prior_price),
        price: Number(row.price),
        delta: Number(row.delta),
        state: row.price_state,
      })),
      [
        {
          effectiveAt: new Date("2026-08-04T10:00:00Z"),
          prior: 70000,
          price: 60000,
          delta: -10000,
          state: "valid",
        },
      ],
    );

    await price(articleId, "2026-08-05T10:00:00Z", 50000);
    await price(articleId, "2026-08-06T10:00:00Z", null, "invalid");
    await price(articleId, "2026-08-07T10:00:00Z", 40000);
    const afterInvalid = await db.pool.query(
      `SELECT effective_at FROM v_listing_price_changes
        WHERE article_id = $1 ORDER BY effective_at`,
      [articleId],
    );
    assert.deepEqual(
      afterInvalid.rows.map((row) => row.effective_at),
      [new Date("2026-08-04T10:00:00Z"), new Date("2026-08-05T10:00:00Z")],
    );
  },
);

needsDb(
  "price changes suppress the first comparison across a deal transition",
  async () => {
    const articleId = 8902;
    await listing(articleId);
    await state(articleId, "2026-08-01T10:00:00Z", false);
    await price(articleId, "2026-08-01T10:00:00Z", 100000);
    await state(articleId, "2026-08-02T10:00:00Z", true);
    await price(articleId, "2026-08-02T10:00:00Z", 90000);
    await price(articleId, "2026-08-03T10:00:00Z", 80000);

    const rows = await db.pool.query(
      `SELECT effective_at, deal, prior_price, price, delta
         FROM v_listing_price_changes
        WHERE article_id = $1`,
      [articleId],
    );
    assert.deepEqual(rows.rows, [
      {
        effective_at: new Date("2026-08-03T10:00:00Z"),
        deal: "rent",
        prior_price: "90000.00",
        price: "80000.00",
        delta: "-10000.00",
      },
    ]);
  },
);
