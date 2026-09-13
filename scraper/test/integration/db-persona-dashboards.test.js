"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  await db.pool.query(`
    INSERT INTO saved_searches(search_key,name,url,category)
    VALUES ('apartments','Apartments','https://olx.ba/pretraga?category_id=23','apartments');
    INSERT INTO listings(article_id,url,title,price,sqm,rooms,is_rent,furnished,location,first_seen,last_seen)
    SELECT id,'https://olx.ba/artikal/'||id,'Persona fixture '||id,
      CASE WHEN id=1 THEN 180000 WHEN id<12 THEN 216000 WHEN id=101 THEN 600 WHEN id BETWEEN 102 AND 111 THEN 750 END,
      CASE WHEN id<12 THEN 60 WHEN id BETWEEN 101 AND 111 THEN 50 END,
      CASE WHEN id IN (12,112) THEN NULL ELSE '2' END,
      id>100,CASE WHEN id BETWEEN 101 AND 111 THEN true END,'Centar 1',now()-interval '2 days',now()
    FROM (SELECT generate_series(1,12) AS id UNION ALL SELECT generate_series(101,112)) x;
    INSERT INTO search_results SELECT 'apartments',article_id FROM listings;
    INSERT INTO listing_state_history(article_id,effective_at,source,event_type,category,category_membership,is_rent,sqm,rooms,filter_attributes)
    SELECT article_id,now()-interval '2 days','search','search_sighting','apartments',ARRAY['apartments'],is_rent,sqm,rooms,
      jsonb_build_object('location','Centar 1','furnished',furnished,'currency','BAM') FROM listings;
    INSERT INTO listing_price_events(article_id,effective_at,source,price,price_state,provenance)
    SELECT article_id,now()-interval '1 hour','search',price,CASE WHEN price IS NULL THEN 'unpriced' ELSE 'valid' END,
      '{"currency":"BAM"}'::jsonb FROM listings;
  `);
});

function dashboard(persona) {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        `../../../grafana/dashboards/olx-${persona}.json`,
      ),
      "utf8",
    ),
  );
}

function interpolate(d, sql, overrides = {}) {
  const values = Object.fromEntries(
    d.templating.list.map((v) => {
      let value = v.current?.value ?? "";
      if (
        value === "$__all" ||
        (Array.isArray(value) && value.includes("$__all"))
      )
        value = v.allValue || "__any__";
      return [v.name, Array.isArray(value) ? value : [value]];
    }),
  );
  for (const [name, value] of Object.entries(overrides))
    values[name] = Array.isArray(value) ? value : [value];
  return sql.replace(/\$\{(\w+):sqlstring\}/g, (_, name) => {
    assert.ok(values[name], `Missing variable ${name}`);
    return values[name]
      .map((v) => `'${String(v).replaceAll("'", "''")}'`)
      .join(",");
  });
}

function listingPanel(d) {
  const panel = d.panels.find(
    (p) =>
      /Interesting (listings|rentals)|Listings to review/i.test(p.title) &&
      p.targets?.length,
  );
  assert.ok(panel, `${d.uid} must have a main listing table`);
  return panel;
}

needsDb(
  "persona default filters retain unscored unknown facts; inclusive budgets preserve shared scores",
  async () => {
    for (const [persona, subject, unknown, price, score] of [
      ["buyer", 1, 12, 180000, 67],
      ["renter", 101, 112, 600, 70],
    ]) {
      const d = dashboard(persona);
      const sql = listingPanel(d).targets[0].rawSql;
      const all = await db.pool.query(interpolate(d, sql));
      assert.equal(all.rowCount, 12, `${persona} default inventory`);
      assert.ok(
        all.rows.some(
          (row) => Number(row.article_id) === unknown && row.score === null,
        ),
        `${persona} unscored retained`,
      );
      const bounded = await db.pool.query(
        interpolate(d, sql, {
          min_price: String(price),
          max_price: String(price),
        }),
      );
      assert.equal(bounded.rowCount, 1);
      assert.equal(Number(bounded.rows[0].article_id), subject);
      assert.equal(bounded.rows[0].score, score);
      const missingArea = await db.pool.query(
        interpolate(d, sql, { min_area: "5" }),
      );
      assert.equal(missingArea.rowCount, 11);
      const agent = dashboard("agent");
      const agentRows = await db.pool.query(
        interpolate(agent, listingPanel(agent).targets[0].rawSql, {
          deal: persona === "renter" ? "rent" : "sale",
          view: "all",
        }),
      );
      assert.equal(
        agentRows.rows.find((row) => Number(row.article_id) === subject).score,
        score,
      );
      const longer = await db.pool.query(
        interpolate(d, sql, { history_days: "90" }),
      );
      assert.deepEqual(
        longer.rows.map((row) => [row.article_id, row.score]),
        all.rows.map((row) => [row.article_id, row.score]),
      );
    }
  },
);

needsDb(
  "persona neighbourhood market medians do not change with budget or score bounds",
  async () => {
    for (const persona of ["buyer", "renter", "agent"]) {
      const d = dashboard(persona);
      const p = d.panels.find(
        (panel) =>
          panel.type === "table" &&
          /Prices by neighbourhood|Rent by neighbourhood|pricing matrix/i.test(
            panel.title,
          ),
      );
      assert.ok(p, `${persona} market context table`);
      const baseline = await db.pool.query(interpolate(d, p.targets[0].rawSql));
      const filtered = await db.pool.query(
        interpolate(d, p.targets[0].rawSql, {
          max_price: persona === "renter" ? "600" : "180000",
          min_score: "60",
        }),
      );
      const medians = (rows) =>
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => /median|p25|p75/i.test(key)),
          ),
        );
      assert.ok(baseline.rowCount > 0);
      assert.deepEqual(medians(filtered.rows), medians(baseline.rows));
    }
  },
);

needsDb(
  "persona validation reports malformed and reversed ranges even with no matching inventory",
  async () => {
    for (const persona of ["buyer", "renter", "agent"]) {
      const d = dashboard(persona);
      const validation = d.panels.find((p) =>
        /validation|filter status/i.test(p.title),
      );
      assert.ok(validation, `${persona} validation panel`);
      for (const bounds of [
        { min_price: "-1" },
        { min_area: "abc" },
        { min_price: "20", max_price: "10" },
        { min_score: "101" },
      ]) {
        await assert.rejects(
          db.pool.query(
            interpolate(d, validation.targets[0].rawSql, {
              property_type: "absent",
              ...bounds,
            }),
          ),
          /non-negative|minimum must not exceed|between 0 and 100/,
        );
      }
    }
  },
);
