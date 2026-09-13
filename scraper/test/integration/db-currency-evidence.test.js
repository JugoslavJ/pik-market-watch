"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db");
const { parseListingDetail } = require("../../src/parser");
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

needsDb(
  "detail persistence keeps current currency separate from historical assertions",
  async () => {
    await db.pool.query(
      "INSERT INTO listings(article_id,url,title) VALUES(123,'https://olx.ba/artikal/123','Currency evidence')",
    );
    await db.enrichListings([
      parseListingDetail({
        id: 123,
        listing_type: "rent",
        price: 600,
        display_price: "600 KM",
        price_history: [
          { price: 700, date: 1700000000 },
          { price: 800, date: 1700000001, currency: "EUR" },
        ],
      }),
    ]);
    const result = await db.pool.query(
      "SELECT source, provenance->>'currency' AS currency FROM listing_price_events ORDER BY effective_at",
    );
    assert.deepEqual(result.rows, [
      { source: "api_price_history", currency: null },
      { source: "api_price_history", currency: "EUR" },
      { source: "detail", currency: "BAM" },
    ]);
    const state = await db.pool.query(
      "SELECT filter_attributes->>'currency' AS currency FROM listing_state_history WHERE event_type='detail_update'",
    );
    assert.equal(state.rows[0].currency, "BAM");
  },
);

needsDb(
  "same-price currency disagreements create a conflict boundary, including repeated imports",
  async () => {
    await db.pool.query(
      "INSERT INTO listings(article_id,url,title) VALUES(123,'https://olx.ba/artikal/123','Currency conflict')",
    );
    const event = {
      articleId: 123,
      effectiveAt: "2025-01-01T00:00:00Z",
      price: 600,
      dealType: "rent",
      source: "search",
      isCurrent: true,
    };
    await db.recordPriceEvents([{ ...event, provenance: { currency: "BAM" } }]);
    const conflict = await db.recordPriceEvents([
      { ...event, provenance: { currency: "EUR" } },
    ]);
    assert.equal(conflict.conflicting, 1);
    const rows = await db.pool.query(
      "SELECT price_state FROM listing_price_events ORDER BY id",
    );
    assert.deepEqual(
      rows.rows.map((row) => row.price_state),
      ["valid", "conflict"],
    );
    const repeat = await db.recordPriceEvents([
      { ...event, provenance: { currency: "EUR" } },
    ]);
    assert.equal(repeat.inserted, 0);
  },
);

needsDb(
  "unknown upstream deal evidence cannot inherit the legacy sale default",
  async () => {
    await db.pool.query(
      "INSERT INTO listings(article_id,url,title,is_rent) VALUES(123,'https://olx.ba/artikal/123','Unknown deal',false)",
    );
    await db.enrichListings([
      parseListingDetail({
        id: 123,
        price: 150000,
        display_price: "150.000 KM",
      }),
    ]);
    const result = await db.pool.query(
      "SELECT evidence_is_rent, asking_price, score_input_reason FROM reporting.current_comparison_inputs WHERE article_id=123",
    );
    assert.equal(result.rows[0].evidence_is_rent, null);
    assert.equal(result.rows[0].asking_price, null);
    assert.match(result.rows[0].score_input_reason, /unknown deal segment/);
  },
);
