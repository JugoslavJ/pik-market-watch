"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const leanInit = path.resolve(__dirname, "../../../db/init-lean");

test("lean baseline contains the complete installed schema", () => {
  const sqlFiles = fs
    .readdirSync(leanInit)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(sqlFiles, [
    "00-extensions.sql",
    "01-lean-schema.sql",
    "02-lean-neighborhoods.sql",
  ]);
  const neighborhoods = fs.readFileSync(
    path.join(leanInit, "02-lean-neighborhoods.sql"),
    "utf8",
  );
  assert.match(neighborhoods, /count\(\*\) FROM lean\.neighborhoods\) <> 56/);
  assert.match(neighborhoods, /ST_Multi\(ST_MakePolygon/);
  const schema = fs.readFileSync(
    path.join(leanInit, "01-lean-schema.sql"),
    "utf8",
  );
  assert.match(schema, /CREATE TABLE lean\.listing_lifecycle_events/);
  assert.match(schema, /CREATE TABLE lean\.raw_api_responses/);
  assert.match(schema, /CREATE TABLE lean\.scrape_run_pages/);
  assert.doesNotMatch(schema, /neighborhood_stats|CREATE MATERIALIZED VIEW/);
  for (const column of [
    "first_seen",
    "published_at",
    "closed_at",
    "renewed_at",
    "occurred_at",
    "opened_at",
    "price_date",
  ]) {
    assert.match(schema, new RegExp(`\\b${column} date\\b`));
  }
  assert.match(
    schema,
    /CREATE UNIQUE INDEX lean_price_history_article_date_source_uidx/,
  );
  assert.doesNotMatch(
    schema,
    /observed_at|UNIQUE \(article_id, event_type, occurred_at\)/,
  );
  assert.match(schema, /lean_scrape_runs_started_at_idx/);
  assert.match(schema, /lean_scrape_runs_search_latest_idx/);
  assert.match(schema, /lean_price_history_api_article_date_idx/);
  for (const file of sqlFiles) {
    const sql = fs.readFileSync(path.join(leanInit, file), "utf8");
    assert.doesNotMatch(
      sql,
      /\b(?:ALTER TABLE|DROP (?:TABLE|COLUMN|CONSTRAINT))\b/i,
    );
  }
});
