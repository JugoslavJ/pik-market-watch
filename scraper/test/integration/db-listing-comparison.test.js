"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;
test.before(async () => {
  if (process.env.TEST_DATABASE_URL) db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(async () => {
  if (!db) return;
  await reset(db.pool);
  await db.pool
    .query(`INSERT INTO saved_searches(search_key,name,url,category) VALUES
    ('apartments','Apartments','https://olx.ba/pretraga?category_id=23','apartments'),
    ('duplicate','Apartments again','https://olx.ba/pretraga?category_id=23&sort=new','apartments'),
    ('houses','Houses','https://olx.ba/pretraga?category_id=24','houses'),
    ('vacation_homes','Vacation homes','https://olx.ba/pretraga?category_id=26','vacation_homes')`);
});

async function seed(entries) {
  const rows = entries.map((entry) => ({
    article_id: entry.id,
    price: 150000,
    sqm: 50,
    rooms: "2",
    is_rent: false,
    furnished: null,
    currency: "BAM",
    price_state: "valid",
    category: "apartments",
    neighborhood: "Centar 1",
    ...entry,
  }));
  const input = JSON.stringify(rows);
  await db.pool.query(
    `INSERT INTO listings(article_id,url,title,price,sqm,rooms,is_rent,furnished,location,first_seen,last_seen)
     SELECT article_id,'https://olx.ba/artikal/'||article_id,'Test '||article_id,price,sqm,rooms,is_rent,furnished,
       (SELECT name FROM neighborhoods WHERE name=x.neighborhood),now()-interval '70 days',now()
     FROM jsonb_to_recordset($1) AS x(article_id bigint,price numeric,sqm numeric,rooms text,
       is_rent boolean,furnished boolean,neighborhood text)`,
    [input],
  );
  await db.pool.query(
    `INSERT INTO search_results SELECT category,article_id FROM jsonb_to_recordset($1)
       AS x(article_id bigint,category text)`,
    [input],
  );
  await db.pool.query(
    `INSERT INTO listing_state_history(article_id,effective_at,source,event_type,is_rent,sqm,rooms,
       category,category_membership,filter_attributes,last_seen_at)
     SELECT article_id,now()-interval '70 days','search','search_sighting',is_rent,sqm,rooms,
       category,ARRAY[category],jsonb_build_object('furnished',furnished),now()
     FROM jsonb_to_recordset($1) AS x(article_id bigint,is_rent boolean,sqm numeric,rooms text,
       category text,furnished boolean)`,
    [input],
  );
  await db.pool.query(
    `INSERT INTO listing_price_events(article_id,effective_at,source,price,price_state,provenance)
     SELECT article_id,now()-interval '2 days','search',price,price_state,jsonb_build_object('currency',currency)
     FROM jsonb_to_recordset($1) AS x(article_id bigint,price numeric,price_state text,currency text)`,
    [input],
  );
}

async function scores(id) {
  const result = await db.pool.query(
    "SELECT * FROM reporting.current_listing_scores WHERE article_id=$1",
    [id],
  );
  return result.rows[0];
}

async function event(id, hoursAgo, price, state = "valid", currency = "BAM") {
  await db.pool.query(
    `INSERT INTO listing_price_events(article_id,effective_at,source,price,price_state,provenance)
     VALUES($1,now()-make_interval(hours=>$2),'search',$3,$4,jsonb_build_object('currency',$5::text))`,
    [id, hoursAgo, price, state, currency],
  );
}

needsDb(
  "exact comparable detail reproduces the displayed median and quartiles",
  async () => {
    await seed([
      { id: 1, price: 80000 },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: index + 2,
        price: 55000 + index * 5000,
      })),
    ]);
    const subject = await scores(1);
    const detail = await db.pool.query(`SELECT count(*)::int AS n,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY asking_rate) AS median,
    percentile_cont(0.25) WITHIN GROUP(ORDER BY asking_rate) AS p25,
    percentile_cont(0.75) WITHIN GROUP(ORDER BY asking_rate) AS p75
    FROM reporting.listing_comparables(1)`);
    assert.deepEqual(detail.rows[0], {
      n: 10,
      median: 1550,
      p25: 1325,
      p75: 1775,
    });
    assert.equal(Number(subject.benchmark_rate), detail.rows[0].median);
    assert.equal(Number(subject.benchmark_p25), detail.rows[0].p25);
    assert.equal(Number(subject.benchmark_p75), detail.rows[0].p75);
    assert.equal(Number(subject.indicative_total), 77500);
    assert.equal(Number(subject.asking_gap_km), 2500);
  },
);

needsDb(
  "9/10/20 exact distinct comparables; budget never changes the benchmark",
  async () => {
    await seed(Array.from({ length: 10 }, (_, id) => ({ id: id + 1 })));
    let subject = await scores(1);
    assert.equal(subject.comparable_count, 9);
    assert.equal(subject.score, null);
    assert.equal(subject.benchmark_rate, null);
    assert.equal(subject.indicative_low, null);
    assert.equal(subject.unscored_reason, "Insufficient comparables");
    await seed([{ id: 11 }]);
    subject = await scores(1);
    assert.equal(subject.comparable_count, 10);
    assert.equal(subject.score, 50);
    assert.equal(subject.confidence, "Limited sample");
    await db.pool.query(
      "INSERT INTO search_results SELECT 'duplicate',article_id FROM listings",
    );
    assert.equal((await scores(1)).comparable_count, 10);
    const cohort = await db.pool.query(
      "SELECT article_id FROM reporting.listing_comparables(1)",
    );
    assert.equal(cohort.rowCount, 10);
    assert.ok(cohort.rows.every((row) => Number(row.article_id) !== 1));
    await seed(Array.from({ length: 10 }, (_, id) => ({ id: id + 12 })));
    subject = await scores(1);
    assert.equal(subject.comparable_count, 20);
    assert.equal(subject.confidence, "Larger sample");
    const filtered = await db.pool
      .query(`SELECT score,benchmark_rate FROM reporting.current_listing_scores
    WHERE article_id=1 AND reporting.within_bounds(asking_price,'150000','150000','Price')
      AND reporting.within_bounds(score,'50','50','Score',100)`);
    assert.equal(filtered.rows[0].score, subject.score);
    assert.equal(filtered.rows[0].benchmark_rate, subject.benchmark_rate);
  },
);

needsDb(
  "formula, unrounded deviation labels, score clamps and illustrative buyer example",
  async () => {
    await seed([
      { id: 1, sqm: 60, price: 180000 },
      ...Array.from({ length: 10 }, (_, id) => ({
        id: id + 2,
        sqm: 60,
        price: 216000,
      })),
    ]);
    const sample = await scores(1);
    assert.equal(sample.score, 67);
    assert.equal(Number(sample.asking_gap_km), -36000);
    assert.ok(
      Math.abs(Number(sample.deviation_pct) + 16.6666666667) < 0.000001,
    );
    for (const [factor, score, label] of [
      [0.1, 100, "Well below"],
      [0.89, 61, "Well below"],
      [0.9, 60, "Below"],
      [0.95, 55, "Near"],
      [1, 50, "Near"],
      [1.05, 45, "Near"],
      [1.1, 40, "Above"],
      [1.11, 39, "Well above"],
      [3, 0, "Well above"],
    ]) {
      await db.pool.query(
        "UPDATE listing_price_events SET price=$1 WHERE article_id=1",
        [216000 * factor],
      );
      const current = await scores(1);
      assert.equal(current.score, score, String(factor));
      assert.ok(
        current.position_label.startsWith(label),
        `${factor}: ${current.position_label}`,
      );
    }
  },
);

needsDb(
  "cohorts require same location, type, rooms and inclusive target area band",
  async () => {
    await seed([
      { id: 1 },
      { id: 2, sqm: 40 },
      { id: 3, sqm: 60 },
      { id: 4, sqm: 39.99 },
      { id: 5, sqm: 60.01 },
      { id: 6, rooms: "3" },
      { id: 7, category: "houses" },
      { id: 8, is_rent: true, price: 600, furnished: true },
      { id: 9, neighborhood: "Unknown place" },
    ]);
    const result = await db.pool.query(
      "SELECT article_id FROM reporting.listing_comparables(1)",
    );
    assert.deepEqual(
      result.rows.map((row) => Number(row.article_id)),
      [2, 3],
    );
    await db.pool.query("INSERT INTO search_results VALUES('houses',1)");
    assert.equal(
      (await scores(1)).unscored_reason,
      "Unknown or ambiguous property type",
    );
    assert.equal(
      (await scores(9)).unscored_reason,
      "Missing mapped neighbourhood",
    );
  },
);

needsDb(
  "invalid/conflicting/unpriced/latest segment and currency evidence never falls back",
  async () => {
    await seed(Array.from({ length: 10 }, (_, id) => ({ id: id + 1 })));
    await event(1, 4, null, "invalid");
    await event(2, 4, null, "unpriced");
    await event(3, 4, 140000, "valid", "EUR");
    await event(4, 4, 140000, "valid", null);
    await db.pool
      .query(`INSERT INTO listing_price_events(article_id,effective_at,source,price,price_state,provenance)
    VALUES (5,now()-interval '4 hours','search',140000,'valid','{"currency":"KM"}'),
           (5,now()-interval '4 hours','detail',NULL,'conflict','{}'),
           (6,now()-interval '4 hours','search',140000,'valid','{"currency":"KM"}'),
           (6,now()-interval '4 hours','legacy_import',NULL,'conflict','{}')`);
    await db.pool.query("UPDATE listings SET is_rent=true WHERE article_id=7");
    await db.pool.query("UPDATE listings SET sqm=NULL WHERE article_id=8");
    await db.pool.query("UPDATE listings SET rooms=NULL WHERE article_id=9");
    const expected = [
      [1, "Invalid current price"],
      [2, "Unpriced current listing"],
      [3, "Unknown or unsupported currency"],
      [4, "Unknown or unsupported currency"],
      [5, "Conflicting current price evidence"],
      [7, "Price evidence belongs to another or unknown deal segment"],
      [8, "Missing area"],
      [9, "Missing or unsupported room bucket"],
    ];
    for (const [id, reason] of expected) {
      const row = await scores(id);
      assert.equal(row.unscored_reason, reason);
      assert.equal(row.score, null);
      if (id < 8) assert.equal(row.asking_price, null);
    }
    assert.equal(Number((await scores(6)).asking_price), 140000);
    await db.pool.query(
      "UPDATE listings SET closed_at=now() WHERE article_id=6",
    );
    await db.pool.query(
      "UPDATE listings SET last_seen=now()-interval '14 days' WHERE article_id=10",
    );
    assert.equal(await scores(6), undefined);
    assert.equal(await scores(10), undefined);
  },
);

needsDb(
  "monthly rentals score 70; furnishing is mandatory and explicit null replaces stale true",
  async () => {
    await seed([
      { id: 1, is_rent: true, furnished: true, price: 600 },
      ...Array.from({ length: 10 }, (_, id) => ({
        id: id + 2,
        is_rent: true,
        furnished: true,
        price: 750,
      })),
      { id: 12, is_rent: true, furnished: false, price: 750 },
      { id: 13, is_rent: true, furnished: null, price: 750 },
    ]);
    const subject = await scores(1);
    assert.equal(subject.score, 70);
    assert.equal(Number(subject.asking_rate), 12);
    assert.equal(Number(subject.asking_gap_km), -150);
    assert.equal(subject.comparable_count, 10);
    assert.equal(
      (await scores(13)).unscored_reason,
      "Unknown or partial furnishing",
    );
    await db.pool
      .query(`INSERT INTO listing_state_history(article_id,effective_at,source,event_type,filter_attributes)
    VALUES(1,now()-interval '1 hour','detail','detail_update','{"furnished":null}')`);
    const partial = await scores(1);
    assert.equal(partial.furnished, null);
    assert.equal(partial.score, null);
    assert.equal(partial.unscored_reason, "Unknown or partial furnishing");
  },
);

needsDb("quality policy and strict optional bound validation", async () => {
  for (const [price, sqm, rent, reason] of [
    [3000, 5, false, null],
    [2999, 5, false, "Implausible asking price"],
    [7500000, 500, false, null],
    [7500500, 500, false, "Implausible sale asking rate"],
    [600, null, true, "Missing area"],
    [600, 4.99, true, "Invalid area"],
    [600, 500.01, true, "Invalid area"],
    [49, 50, true, "Implausible asking price"],
    [50, 5, true, null],
    [600, 500, true, null],
    [100000, 5, true, null],
  ]) {
    const result = await db.pool.query(
      "SELECT reporting.comparison_quality_reason($1,'valid','BAM',$2,$3) reason",
      [price, sqm, rent],
    );
    assert.equal(result.rows[0].reason, reason, `${price}/${sqm}/${rent}`);
  }
  const result = await db.pool.query(`SELECT
    reporting.within_bounds(NULL,'','','Area') AS unrestricted,
    reporting.within_bounds(NULL,'1','','Area') AS missing,
    reporting.within_bounds(5,'5','5','Area') AS inclusive`);
  assert.deepEqual(result.rows[0], {
    unrestricted: true,
    missing: false,
    inclusive: true,
  });
  for (const [minimum, maximum, message] of [
    ["-1", "", /non-negative/],
    ["12oops", "", /non-negative/],
    ["NaN", "", /non-negative/],
    ["1e3", "", /non-negative/],
    ["6", "5", /minimum must not exceed/],
  ]) {
    await assert.rejects(
      db.pool.query("SELECT reporting.within_bounds(5,$1,$2,'Area')", [
        minimum,
        maximum,
      ]),
      message,
    );
  }
  await assert.rejects(
    db.pool.query("SELECT reporting.within_bounds(50,'','101','Score',100)"),
    /between 0 and 100/,
  );
});

needsDb(
  "applicable reductions expire on increases, invalid/currency/deal boundaries and reopening",
  async () => {
    await seed([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
      { id: 6 },
    ]);
    for (let id = 1; id <= 6; id++) await event(id, 20, 140000);
    await event(1, 10, 140000); // An unchanged observation preserves the reduction.
    await event(2, 10, 145000);
    await event(3, 10, null, "invalid");
    await event(3, 5, 140000);
    await event(4, 10, 140000, "valid", "EUR");
    await event(4, 5, 140000);
    await db.pool
      .query(`INSERT INTO listing_state_history(article_id,effective_at,source,event_type,is_rent)
    VALUES(5,now()-interval '12 hours','search','search_sighting',true),
          (5,now()-interval '6 hours','search','search_sighting',false),
          (6,now()-interval '10 hours','search','reopened',NULL)`);
    await event(5, 5, 140000);
    const good = await scores(1);
    assert.equal(Number(good.reduction_km), 10000);
    assert.ok(good.latest_reduction_at);
    for (let id = 2; id <= 6; id++)
      assert.equal((await scores(id)).latest_reduction_at, null, String(id));
    const reopened = await scores(6);
    assert.equal(reopened.reopened, true);
    assert.equal(reopened.current_cycle_age_days, 0);
    assert.equal(good.current_cycle_age_days, 70);
    await db.pool.query("DELETE FROM listing_state_history WHERE article_id=1");
    assert.equal((await scores(1)).current_cycle_age_days, null);
  },
);
