"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db");

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

async function listing(articleId, current = {}) {
  await db.pool.query(
    `INSERT INTO listings
       (article_id, url, title, is_rent, sqm, rooms, location, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01T09:00:00Z', now())`,
    [
      articleId,
      `https://olx.ba/artikal/${articleId}`,
      current.title ?? `listing ${articleId}`,
      current.isRent ?? false,
      current.sqm ?? 999,
      current.rooms ?? "9",
      current.location ?? "Current-only location",
    ],
  );
}

async function state(articleId, at, values = {}) {
  await db.pool.query(
    `INSERT INTO listing_state_history
       (article_id, effective_at, source, event_type, category,
        category_membership, is_rent, sqm, rooms, filter_attributes,
        membership_inferred, attributes_inferred)
     VALUES ($1, $2, 'fixture', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
    [
      articleId,
      at,
      values.event ?? "search_sighting",
      values.category ?? null,
      values.memberships ?? [],
      values.isRent ?? null,
      values.sqm ?? null,
      values.rooms ?? null,
      JSON.stringify(values.attributes ?? {}),
      values.membershipInferred ?? false,
      values.attributesInferred ?? false,
    ],
  );
}

async function price(
  articleId,
  at,
  value,
  stateName = "valid",
  currency = "BAM",
) {
  await db.pool.query(
    `INSERT INTO listing_price_events
       (article_id, effective_at, observed_at, source, price, price_state, provenance)
     VALUES ($1, $2, $2, 'fixture', $3, $4, jsonb_build_object('currency', $5::text))`,
    [articleId, at, value, stateName, currency],
  );
}

needsDb(
  "persona history keeps event-time attributes and applies category fallback and BAM monthly rental samples",
  async () => {
    await listing(17001, {
      isRent: true,
      sqm: 999,
      rooms: "9",
      location: "Current-only location",
    });
    await state(17001, "2026-01-10T10:00:00Z", {
      category: "apartments",
      memberships: [],
      isRent: false,
      sqm: 60,
      rooms: "2",
      attributes: {
        location: "Historical center",
        sellerType: "private",
        furnished: true,
        floorNum: "3",
      },
    });
    await price(17001, "2026-01-10T10:00:00Z", 120000);

    await listing(17002, { isRent: false, sqm: 999, rooms: "9" });
    await state(17002, "2026-01-10T10:00:00Z", {
      category: "apartments",
      memberships: ["apartments"],
      isRent: true,
      sqm: 50,
      rooms: "2",
      attributes: { location: "Rental history", furnished: false },
    });
    await price(17002, "2026-01-10T10:00:00Z", 850);

    await db.pool.query(
      "SELECT * FROM rebuild_listing_daily('2026-01-10', '2026-01-10')",
    );
    const rows = await db.pool.query(
      `SELECT article_id, category_memberships, deal, property_type, sqm, rooms,
              neighborhood, historical_seller_type, historical_furnished,
              historical_floor_num, currency, asking_price, asking_rate,
              asking_price_unit, asking_rate_unit, price_eligible, rate_eligible
         FROM reporting.daily_listing_facts
        WHERE day = '2026-01-10'
        ORDER BY article_id`,
    );

    assert.deepEqual(rows.rows[0], {
      article_id: "17001",
      category_memberships: ["apartments"],
      deal: "sale",
      property_type: "apartments",
      sqm: "60.00",
      rooms: "2",
      neighborhood: "Historical center",
      historical_seller_type: "private",
      historical_furnished: true,
      historical_floor_num: 3,
      currency: "BAM",
      asking_price: "120000.00",
      asking_rate: "2000.0000000000000000",
      asking_price_unit: "KM",
      asking_rate_unit: "KM/m²",
      price_eligible: true,
      rate_eligible: true,
    });
    assert.deepEqual(rows.rows[1], {
      article_id: "17002",
      category_memberships: ["apartments"],
      deal: "rent",
      property_type: "apartments",
      sqm: "50.00",
      rooms: "2",
      neighborhood: "Rental history",
      historical_seller_type: null,
      historical_furnished: false,
      historical_floor_num: null,
      currency: "BAM",
      asking_price: "850.00",
      asking_rate: "17.0000000000000000",
      asking_price_unit: "KM/month",
      asking_rate_unit: "KM/m²/month",
      price_eligible: true,
      rate_eligible: true,
    });
  },
);

needsDb(
  "persona history keeps invalid and deal-switch price boundaries ineligible",
  async () => {
    await listing(17003);
    await state(17003, "2026-01-10T09:00:00Z", {
      category: "apartments",
      memberships: ["apartments"],
      isRent: false,
      sqm: 60,
      rooms: "2",
      attributes: { location: "Boundary" },
    });
    await price(17003, "2026-01-10T09:00:00Z", 120000);
    await state(17003, "2026-01-11T09:00:00Z", {
      event: "detail_update",
      isRent: true,
    });
    await state(17003, "2026-01-12T09:00:00Z", {
      event: "detail_update",
      isRent: false,
    });

    await listing(17004);
    await state(17004, "2026-01-10T09:00:00Z", {
      category: "apartments",
      memberships: ["apartments"],
      isRent: false,
      sqm: 60,
      rooms: "2",
      attributes: { location: "Invalid" },
    });
    await price(17004, "2026-01-10T09:00:00Z", null, "invalid");

    await db.pool.query(
      "SELECT * FROM rebuild_listing_daily('2026-01-10', '2026-01-12')",
    );
    const boundary = await db.pool.query(
      `SELECT price_quality_reason, rate_quality_reason, price_eligible,
              rate_eligible, asking_price, asking_rate
         FROM reporting.daily_listing_facts
        WHERE article_id = 17003 AND day = '2026-01-12'`,
    );
    assert.deepEqual(boundary.rows[0], {
      price_quality_reason: "price evidence predates a deal switch",
      rate_quality_reason: "price evidence predates a deal switch",
      price_eligible: false,
      rate_eligible: false,
      asking_price: null,
      asking_rate: null,
    });
    const invalid = await db.pool.query(
      `SELECT price_quality_reason, price_eligible, rate_eligible, asking_price
         FROM reporting.daily_listing_facts
        WHERE article_id = 17004 AND day = '2026-01-10'`,
    );
    assert.deepEqual(invalid.rows[0], {
      price_quality_reason: "Invalid current price",
      price_eligible: false,
      rate_eligible: false,
      asking_price: null,
    });
  },
);

needsDb(
  "lifecycle freezes each sparse closure and never uses a later reopening or reused sale price",
  async () => {
    await listing(17005, { location: "Current-only location" });
    await state(17005, "2026-01-10T09:00:00Z", {
      category: "apartments",
      memberships: ["apartments"],
      isRent: false,
      sqm: 55,
      rooms: "2",
      attributes: {
        location: "Original location",
        sellerType: "private",
        condition: "old",
        furnished: true,
      },
    });
    await state(17005, "2026-01-11T09:00:00Z", {
      event: "detail_update",
      sqm: 60,
      attributes: { floorNum: "4" },
    });
    await price(17005, "2026-01-11T09:00:00Z", 100000);
    await state(17005, "2026-01-12T09:00:00Z", {
      event: "closed",
      attributes: { location: null, sellerType: "agency" },
    });
    await state(17005, "2026-01-13T09:00:00Z", {
      event: "reopened",
      attributes: { condition: "new" },
    });
    await price(17005, "2026-01-13T09:00:00Z", 110000);
    await state(17005, "2026-01-14T09:00:00Z", {
      event: "closed",
      attributes: { parking: true },
    });

    await listing(17006);
    await state(17006, "2026-01-10T09:00:00Z", {
      category: "apartments",
      memberships: ["apartments"],
      isRent: false,
      sqm: 60,
      rooms: "2",
      attributes: { location: "Series boundary" },
    });
    await price(17006, "2026-01-10T09:00:00Z", 120000);
    await state(17006, "2026-01-11T09:00:00Z", {
      event: "detail_update",
      isRent: true,
    });
    await state(17006, "2026-01-12T09:00:00Z", {
      event: "detail_update",
      isRent: false,
    });
    await state(17006, "2026-01-13T09:00:00Z", { event: "closed" });

    const rows = await db.pool.query(
      `SELECT article_id, cycle_no, closing_category, closing_sqm, closing_rooms,
              closing_neighborhood, closing_attributes, closing_membership_inferred,
              closing_attributes_inferred,
              closing_price_quality_reason, closing_price_eligible, final_asking_price
         FROM reporting.lifecycle_cycles
        WHERE article_id IN (17005, 17006)
        ORDER BY article_id, cycle_no`,
    );
    assert.equal(rows.rowCount, 3);
    assert.deepEqual(rows.rows[0], {
      article_id: "17005",
      cycle_no: "1",
      closing_category: "apartments",
      closing_sqm: "60.00",
      closing_rooms: "2",
      closing_neighborhood: "(no pin)",
      closing_attributes: {
        condition: "old",
        floorNum: "4",
        furnished: true,
        location: null,
        sellerType: "agency",
      },
      closing_membership_inferred: true,
      closing_attributes_inferred: true,
      closing_price_quality_reason: null,
      closing_price_eligible: true,
      final_asking_price: "100000.00",
    });
    assert.deepEqual(rows.rows[1], {
      article_id: "17005",
      cycle_no: "2",
      closing_category: "apartments",
      closing_sqm: "60.00",
      closing_rooms: "2",
      closing_neighborhood: "Original location",
      closing_attributes: {
        condition: "new",
        floorNum: "4",
        furnished: true,
        location: "Original location",
        parking: true,
        sellerType: "private",
      },
      closing_membership_inferred: true,
      closing_attributes_inferred: true,
      closing_price_quality_reason: null,
      closing_price_eligible: true,
      final_asking_price: "110000.00",
    });
    assert.deepEqual(rows.rows[2], {
      article_id: "17006",
      cycle_no: "1",
      closing_category: "apartments",
      closing_sqm: "60.00",
      closing_rooms: "2",
      closing_neighborhood: "Series boundary",
      closing_attributes: { location: "Series boundary" },
      closing_membership_inferred: true,
      closing_attributes_inferred: true,
      closing_price_quality_reason: "price evidence predates a deal switch",
      closing_price_eligible: false,
      final_asking_price: null,
    });
  },
);
