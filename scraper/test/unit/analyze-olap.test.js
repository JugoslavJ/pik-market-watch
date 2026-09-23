"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  analyzePublishedOlap,
  captureOlapAnalyzeTargets,
} = require("../../src/db/analyze-olap");

test("full publication targets every registered daily facts partition", async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT EXISTS/.test(sql))
        return { rows: [{ has_daily_publication: false }] };
      if (/analytics_partition_registry/.test(sql))
        return { rows: [{ child_table: "daily_listing_facts_2026_09" }] };
      throw new Error("unexpected query");
    },
  };

  assert.deepEqual(await captureOlapAnalyzeTargets(pool), [
    "daily_listing_facts_2026_09",
  ]);
  assert.deepEqual(calls[1].params, [true, []]);
});

test("incremental publication targets only months with queued dirty days", async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT EXISTS/.test(sql))
        return { rows: [{ has_daily_publication: true }] };
      if (/analytics_daily_olap_dirty/.test(sql))
        return { rows: [{ month: "2026-09-01" }] };
      if (/analytics_partition_registry/.test(sql))
        return { rows: [{ child_table: "daily_listing_facts_2026_09" }] };
      throw new Error("unexpected query");
    },
  };

  assert.deepEqual(await captureOlapAnalyzeTargets(pool), [
    "daily_listing_facts_2026_09",
  ]);
  assert.deepEqual(calls[2].params, [false, ["2026-09-01"]]);
});

test("publication analysis invokes the scoped OLAP analyze function", async () => {
  let executed;
  let params;
  const result = await analyzePublishedOlap(
    {
      query: async (sql, values) => {
        executed = sql;
        params = values;
        return { rows: [{ relations: 1 }] };
      },
    },
    ["daily_listing_facts_2026_09"],
  );

  assert.equal(
    executed,
    "SELECT public.analyze_published_olap($1::text[]) AS relations",
  );
  assert.deepEqual(params, [["daily_listing_facts_2026_09"]]);
  assert.deepEqual(result, { relations: 3 });
});

test("database analyze migration restricts dynamic targets to registered fact children", () => {
  const migration = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../db/init/14-stage6-targeted-olap-analyze.sql",
    ),
    "utf8",
  );

  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /parent_table = 'daily_listing_facts'/);
  assert.match(migration, /ANALYZE olap\.listings/);
  assert.match(migration, /ANALYZE olap\.listing_categories/);
  assert.match(migration, /EXECUTE format\('ANALYZE %I\.%I'/);
  assert.match(migration, /REVOKE|GRANT EXECUTE ON FUNCTION/);
});
