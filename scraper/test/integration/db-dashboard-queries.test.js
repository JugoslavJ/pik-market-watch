"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { needsDb, reset, setupDb } = require("../helpers/db.js");
const root = path.resolve(__dirname, "../../..");
const dashboards = ["dashboards", "public-dashboards"].flatMap((dir) =>
  fs
    .readdirSync(path.join(root, "grafana", dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      dashboard: JSON.parse(
        fs.readFileSync(path.join(root, "grafana", dir, f), "utf8"),
      ),
    })),
);
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;

needsDb(
  "public history panels include legacy category-only evidence",
  async () => {
    await reset(db.pool);
    await db.pool.query(`
    INSERT INTO listings (article_id, url, title, first_seen, closed_at)
    VALUES (3, 'https://olx.ba/artikal/3', 'legacy exit', now()-interval '3 days', now()-interval '1 day');
    INSERT INTO listing_state_history (article_id, effective_at, source, event_type, category, is_rent, sqm, rooms)
    VALUES (3, now()-interval '3 days', 'search', 'search_sighting', 'apartments', false, 50, '2'),
           (3, now()-interval '1 day', 'search', 'closed', NULL, NULL, NULL, NULL);
    INSERT INTO listing_price_events (article_id, effective_at, source, price_state, price)
    VALUES (3, now()-interval '3 days', 'search', 'valid', 100000),
           (3, now()-interval '2 days', 'search', 'valid', 90000);
  `);
    const sql = (file, id) =>
      dashboards
        .find((d) => d.name === file)
        .dashboard.panels.find((p) => p.id === id).targets[0].rawSql;
    const reductions = await db.pool.query(sql("olx-public-home.json", 6));
    assert.equal(reductions.rowCount, 1);
    const exits = await db.pool.query(sql("olx-public-exits.json", 1));
    assert.equal(exits.rows[0].observed_exits, 1);
  },
);
function interpolate(sql, values) {
  return sql
    .replace(/\$\{(\w+):sqlstring\}/g, (_, key) =>
      values[key].map(quote).join(","),
    )
    .replace(
      /\$__timeFilter\(([^)]+)\)/g,
      "$1 BETWEEN now()-interval '90 days' AND now()",
    )
    .replace(/\$__timeFrom\(\)/g, "(now()-interval '90 days')")
    .replace(/\$__timeTo\(\)/g, "now()");
}
let db;
test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});

needsDb(
  "every dashboard query executes for empty data and selected sale/rent filters",
  async () => {
    await reset(db.pool);
    const values = {
      category: ["apartments", "houses"],
      deal: ["sell", "rent"],
      rooms: ["2", "unknown"],
      neighborhood: ["(no pin)", "O'Brien"],
      min_sqm: ["0"],
      max_sqm: ["99999"],
    };
    for (const scenario of ["empty", "sale", "rent", "no match"]) {
      if (scenario === "sale") {
        await db.pool.query(`
        INSERT INTO saved_searches (search_key, name, url, category)
        VALUES ('sale', 'sale', 'https://olx.ba/pretraga', 'apartments');
        INSERT INTO listings (article_id, url, title, price, ppm2, sqm, rooms, is_rent, first_seen, last_seen)
        VALUES (1, 'https://olx.ba/artikal/1', 'sale', 100000, 2000, 50, '2', false, now(), now()),
               (2, 'https://olx.ba/artikal/2', 'rent', 500, NULL, 50, '2', true, now(), now());
        INSERT INTO search_results (search_key, article_id) VALUES ('sale', 1), ('sale', 2);
      `);
      }
      const selected = {
        ...values,
        deal:
          scenario === "rent"
            ? ["rent"]
            : scenario === "sale"
              ? ["sell"]
              : values.deal,
      };
      if (scenario === "no match") {
        selected.category = ["missing"];
        selected.min_sqm = ["invalid input"];
        selected.max_sqm = [""];
      }
      for (const { name, dashboard } of dashboards) {
        for (const v of dashboard.templating?.list || [])
          if (v.type === "query") await db.pool.query(v.query);
        for (const a of dashboard.annotations?.list || [])
          if (a.rawSql) await db.pool.query(interpolate(a.rawSql, selected));
        for (const p of dashboard.panels) {
          const names = new Set();
          for (const t of p.targets || []) {
            const result = await db.pool
              .query(interpolate(t.rawSql, selected))
              .catch((e) => {
                e.message = `${name} panel ${p.id}/${t.refId} (${scenario}): ${e.message}`;
                throw e;
              });
            result.fields.forEach((f) => names.add(f.name));
          }
          if (!p.transformations?.length)
            for (const o of p.fieldConfig?.overrides || []) {
              if (o.matcher.id === "byName")
                assert.ok(
                  names.has(o.matcher.options),
                  `${name} panel ${p.id}: override references missing field ${o.matcher.options}`,
                );
            }
        }
      }
      const yieldPanel = dashboards
        .find((x) => x.name === "olx-overview.json")
        .dashboard.panels.find((p) => p.id === 27);
      const ratio = await db.pool.query(
        interpolate(yieldPanel.targets[0].rawSql, selected),
      );
      assert.equal(
        ratio.rows[0].gross_yield_pct,
        ["sale", "rent"].includes(scenario) ? 6 : null,
      );
    }
  },
);
