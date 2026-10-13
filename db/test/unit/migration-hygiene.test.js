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
    "01-baseline-schema.sql":
      "86c2b5edfbfe45c22f1abb777183f5ce9c1a1d7676e1228b3c6bf34393a68e47",
    "02-baseline-neighborhoods.sql":
      "3a1d8a0146e72fdd7557f2d4e60bbcc6b75469fb72b4a9e3a22c5cc7f0bab8e1",
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
});

test("baseline describes the current schema without changing it", () => {
  const read = (file) => fs.readFileSync(path.join(leanInit, file), "utf8");
  const schema = read("01-baseline-schema.sql");
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
  assert.equal(
    schema.match(
      /CHECK \(deal IN \('sale', 'rent', 'daily_rent', 'unknown'\)\)/g,
    )?.length,
    2,
  );
  assert.match(schema, /outline jsonb GENERATED ALWAYS AS/);
  assert.match(schema, /retired_at timestamptz/);
  assert.match(
    schema,
    /REFERENCES lean\.neighborhoods\(name\) ON UPDATE CASCADE/,
  );
  assert.doesNotMatch(schema, /DEFAULT 'BAM'|\bcategory text\b/);
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
  assert.doesNotMatch(
    schema,
    /lean_listings_geo_idx|lean_listings_search_keys_idx|lean_raw_api_responses_article_idx/,
  );

  const neighborhoods = read("02-baseline-neighborhoods.sql");
  assert.match(neighborhoods, /count\(\*\) FROM lean\.neighborhoods\) <> 56/);
  assert.match(neighborhoods, /ST_Multi\(ST_MakePolygon/);
  assert.match(neighborhoods, /\('Obilićevo', ARRAY/);
  assert.doesNotMatch(neighborhoods, /'Obilicevo'|ON CONFLICT/);

  for (const file of [
    "00-extensions.sql",
    "01-baseline-schema.sql",
    "02-baseline-neighborhoods.sql",
  ])
    assert.doesNotMatch(
      read(file),
      /\b(?:ALTER TABLE|DROP|UPDATE lean\.|DELETE FROM|RENAME)\b/i,
      `${file}: the baseline creates the current schema directly`,
    );
});
