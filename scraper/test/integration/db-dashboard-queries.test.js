"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { needsDb, reset, setupDb } = require("../helpers/db.js");
const root = path.resolve(__dirname, "../../..");
const dashboards = fs
  .readdirSync(path.join(root, "grafana", "dashboards"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    name: f,
    dashboard: JSON.parse(
      fs.readFileSync(path.join(root, "grafana", "dashboards", f), "utf8"),
    ),
  }));
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;

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

function dashboardValues(dashboard, selected, scenario) {
  const defaults = Object.fromEntries(
    (dashboard.templating?.list || []).map((variable) => {
      let value = variable.current?.value ?? "";
      if (
        value === "$__all" ||
        (Array.isArray(value) && value.includes("$__all"))
      ) {
        value = variable.allValue || "__any__";
      }
      return [variable.name, Array.isArray(value) ? value : [value]];
    }),
  );
  const result = { ...defaults, ...selected };
  if (["olx-buyer", "olx-renter", "olx-agent"].includes(dashboard.uid)) {
    result.deal = [scenario === "rent" ? "rent" : "sale"];
    result.property_type = [scenario === "no match" ? "missing" : "apartments"];
  }
  return result;
}
let db;
test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});

needsDb(
  "daily OLAP queue retains a reconstruction that commits during publication",
  async () => {
    await reset(db.pool);
    await db.pool.query(`INSERT INTO analytics_daily_coverage(day, provisional)
                         VALUES ('2026-01-10', false)`);
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) AS n FROM analytics_daily_olap_dirty",
          )
        ).rows[0].n,
      ),
      0,
    );

    const rebuilding = await db.pool.connect();
    try {
      await rebuilding.query("BEGIN");
      await rebuilding.query(`UPDATE analytics_daily_coverage
                                  SET rebuilt_at = now()
                                WHERE day = '2026-01-10'`);
      await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
      await rebuilding.query("COMMIT");
    } catch (error) {
      await rebuilding.query("ROLLBACK");
      throw error;
    } finally {
      rebuilding.release();
    }

    const pending = await db.pool.query(
      "SELECT day::text AS day FROM analytics_daily_olap_dirty",
    );
    assert.deepEqual(
      pending.rows.map((row) => row.day),
      ["2026-01-10"],
    );
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) AS n FROM analytics_daily_olap_dirty",
          )
        ).rows[0].n,
      ),
      0,
    );
  },
);

needsDb("failed OLAP publication preserves the prior generation", async () => {
  await reset(db.pool);
  await db.pool.query(`INSERT INTO listings(article_id, url, title)
                       VALUES (9001, 'https://olx.ba/artikal/9001', 'rollback sentinel')`);
  await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
  const before = await db.pool.query(
    "SELECT refresh_id, row_count FROM olap.refresh_state WHERE mart='listings'",
  );
  await db.pool.query(`
    CREATE FUNCTION public.test_fail_olap_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected OLAP failure'; END $$;
    CREATE TRIGGER test_fail_olap_insert BEFORE INSERT ON olap.listings
    FOR EACH STATEMENT EXECUTE FUNCTION public.test_fail_olap_insert();
  `);
  try {
    await assert.rejects(
      db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()"),
      /injected OLAP failure/,
    );
  } finally {
    await db.pool.query("DROP TRIGGER test_fail_olap_insert ON olap.listings");
    await db.pool.query("DROP FUNCTION public.test_fail_olap_insert()");
  }
  const after = await db.pool.query(
    "SELECT refresh_id, row_count FROM olap.refresh_state WHERE mart='listings'",
  );
  assert.deepEqual(after.rows, before.rows);
  assert.equal(
    Number(
      (await db.pool.query("SELECT count(*) AS n FROM olap.listings")).rows[0]
        .n,
    ),
    1,
  );
});

needsDb(
  "empty OLAP refresh and dashboard query stay within CI budgets",
  async () => {
    await reset(db.pool);
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    let started = process.hrtime.bigint();
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    const refreshMs = Number(process.hrtime.bigint() - started) / 1e6;
    started = process.hrtime.bigint();
    await db.pool.query(
      "SELECT count(*), max(article_id) FROM reporting.current_listing_scores",
    );
    const queryMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(
      refreshMs < 5000,
      `empty incremental refresh took ${refreshMs.toFixed(1)}ms`,
    );
    assert.ok(
      queryMs < 1000,
      `representative dashboard query took ${queryMs.toFixed(1)}ms`,
    );
  },
);

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
      await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
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
        const interpolatedValues = dashboardValues(
          dashboard,
          selected,
          scenario,
        );
        for (const v of dashboard.templating?.list || [])
          if (v.type === "query")
            await db.pool.query(interpolate(v.query, interpolatedValues));
        for (const a of dashboard.annotations?.list || [])
          if (a.rawSql)
            await db.pool.query(interpolate(a.rawSql, interpolatedValues));
        for (const p of dashboard.panels) {
          const names = new Set();
          for (const t of p.targets || []) {
            const result = await db.pool
              .query(interpolate(t.rawSql, interpolatedValues))
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
