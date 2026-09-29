"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const init = path.resolve(__dirname, "../../../db/init");
const leanInit = path.resolve(__dirname, "../../../db/init-lean");

test("init contains the current canonical schema and ordered extensions", () => {
  const sqlFiles = fs
    .readdirSync(init)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(sqlFiles, [
    "00-core-schemas.sql",
    "01-storage-json.sql",
    "01-tables.sql",
    "02-constraints.sql",
    "03-functions.sql",
    "03-z-state-attribute-storage.sql",
    "03-zz-storage-json.sql",
    "04-source-views.sql",
    "05-reporting-functions.sql",
    "06-reporting-views.sql",
    "07-indexes.sql",
    "08-triggers.sql",
    "09-neighborhood-data.sql",
    "10-seed-and-access.sql",
    "11-postgis.sql",
    "12-pg-stat-statements.sql",
    "13-raw-json-storage.sql",
  ]);
});

test("lean first-boot baseline contains its complete minimal schema", () => {
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
