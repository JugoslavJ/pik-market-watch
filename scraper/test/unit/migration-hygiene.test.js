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
    "03-raw-archive.sql",
    "04-date-based-price-history.sql",
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
  assert.doesNotMatch(schema, /neighborhood_stats|CREATE MATERIALIZED VIEW/);
  const daily = fs.readFileSync(
    path.join(leanInit, "04-date-based-price-history.sql"),
    "utf8",
  );
  assert.match(daily, /ALTER COLUMN occurred_at TYPE date/);
  assert.match(daily, /ALTER COLUMN opened_at TYPE date/);
  assert.match(daily, /PARTITION BY article_id, price_date, source/);
  assert.match(daily, /observed_at DESC, id DESC/);
  assert.match(daily, /DROP COLUMN observed_at/);
});
