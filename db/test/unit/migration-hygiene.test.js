"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { migrationChecksum } = require("../../src/migrate");

const leanInit = path.resolve(__dirname, "../../../db/init-lean");

test("immutable baseline remains intact and ordered migrations can extend it", () => {
  const sqlFiles = fs
    .readdirSync(leanInit)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const baseline = {
    "00-extensions.sql":
      "e9a3dbd3a5ad094964b7a30004ed4464e711b25fb9f59de3e14233fa71a38472",
    "01-lean-schema.sql":
      "d55b4ec8c8a18e28c4e5c37c1652c6a6c040905591b2cca0011c378d35fa187d",
    "02-lean-neighborhoods.sql":
      "d08c807494dbddf739525b77bc3d7186866a07dcca46bdead6499c60dc5e2227",
  };
  assert.deepEqual(sqlFiles.slice(0, 3), Object.keys(baseline));
  const numbers = sqlFiles.map((file) => {
    assert.match(file, /^\d{2,}-[a-z0-9-]+\.sql$/);
    return Number(file.split("-")[0]);
  });
  assert.equal(
    new Set(numbers).size,
    numbers.length,
    "migration numbers must be unique",
  );
  for (const [file, checksum] of Object.entries(baseline)) {
    assert.equal(
      migrationChecksum(fs.readFileSync(path.join(leanInit, file), "utf8")),
      checksum,
      `${file}: append a migration instead of rewriting the baseline`,
    );
  }
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
  for (const file of Object.keys(baseline)) {
    const sql = fs.readFileSync(path.join(leanInit, file), "utf8");
    assert.doesNotMatch(
      sql,
      /\b(?:ALTER TABLE|DROP (?:TABLE|COLUMN|CONSTRAINT))\b/i,
    );
  }
});
