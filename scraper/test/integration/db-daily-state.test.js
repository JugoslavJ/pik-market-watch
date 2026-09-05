"use strict";

// Regression coverage for sparse lifecycle rows resolved by
// 18-daily-sparse-state-resolution.sql.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;
const sarajevoDay = (value) =>
  value.toLocaleDateString("en-CA", { timeZone: "Europe/Sarajevo" });

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
  "daily state keeps rich attributes and memberships across sparse reopenings",
  async () => {
    const articleId = 8901;
    await db.pool.query(
      `INSERT INTO listings
         (article_id, url, title, is_rent, first_seen, last_seen)
       VALUES ($1, $2, 'sparse lifecycle fixture', false,
               '2026-01-10T12:00:00Z', '2026-01-12T12:00:00Z')`,
      [articleId, `https://olx.ba/artikal/${articleId}`],
    );

    const history = [
      {
        at: "2026-01-10T12:00:00Z",
        event: "search_sighting",
        category: "apartments",
        memberships: ["apartments"],
        sqm: 55,
        rooms: "2",
        attrs: { location: "Center", latitude: "44.78" },
      },
      {
        at: "2026-01-10T13:00:00Z",
        event: "detail_update",
        sqm: 62,
        attrs: { location: "Center", latitude: "44.78", sellerType: "private" },
      },
      {
        at: "2026-01-10T14:00:00Z",
        event: "search_sighting",
        category: "houses",
        memberships: ["houses"],
        attrs: { searchAttributes: { location: "Center" } },
      },
      {
        at: "2026-01-11T12:00:00Z",
        event: "closed",
        closed: true,
      },
      {
        at: "2026-01-12T12:00:00Z",
        event: "reopened",
      },
    ];
    for (const row of history) {
      await db.pool.query(
        `INSERT INTO listing_state_history
           (article_id, effective_at, source, event_type, category,
            category_membership, sqm, rooms, filter_attributes,
            last_seen_at, is_closed)
         VALUES ($1, $2, 'fixture', $3, $4, $5, $6, $7, $8::jsonb,
                 $2, $9)`,
        [
          articleId,
          row.at,
          row.event,
          row.category ?? null,
          row.memberships ?? [],
          row.sqm ?? null,
          row.rooms ?? null,
          JSON.stringify(row.attrs ?? {}),
          row.closed ?? false,
        ],
      );
    }

    await db.pool.query(
      `INSERT INTO listing_price_events
         (article_id, effective_at, observed_at, price, price_state,
          source, effective_at_basis)
       VALUES ($1, '2026-01-10T12:00:00Z', '2026-01-10T12:00:00Z',
               124000, 'valid', 'fixture', 'observed')`,
      [articleId],
    );

    await db.pool.query(
      "SELECT * FROM rebuild_listing_daily('2026-01-10', '2026-01-12')",
    );
    const rows = (
      await db.pool.query(
        `SELECT day, category, category_memberships, sqm, rooms,
                filter_attributes, membership_inferred, attributes_inferred
           FROM listing_daily
          WHERE article_id = $1
          ORDER BY day`,
        [articleId],
      )
    ).rows;

    assert.deepEqual(
      rows.map((row) => sarajevoDay(row.day)),
      ["2026-01-10", "2026-01-12"],
    );
    const reopened = rows[1];
    assert.equal(reopened.category, "houses");
    assert.deepEqual(reopened.category_memberships, ["apartments", "houses"]);
    assert.equal(reopened.sqm, "62.00");
    assert.equal(reopened.rooms, "2");
    assert.equal(reopened.filter_attributes.location, "Center");
    assert.equal(reopened.filter_attributes.sellerType, "private");
    assert.equal(reopened.membership_inferred, true);
    assert.equal(reopened.attributes_inferred, true);
  },
);
