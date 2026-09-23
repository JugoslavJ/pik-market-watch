"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const init = path.resolve(__dirname, "../../../db/init");

test("init contains the canonical schema and additive Stage 5 migration", () => {
  const sqlFiles = fs
    .readdirSync(init)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(sqlFiles, [
    "00-core-schemas.sql",
    "01-tables.sql",
    "02-constraints.sql",
    "03-functions.sql",
    "04-source-views.sql",
    "05-reporting-functions.sql",
    "06-reporting-views.sql",
    "07-indexes.sql",
    "08-triggers.sql",
    "09-neighborhood-data.sql",
    "10-seed-and-access.sql",
    "11-postgis.sql",
    "12-pg-stat-statements.sql",
    "13-stage5-historical-olap-facts.sql",
  ]);

  const migrationFiles = fs
    .readdirSync(init)
    .filter((name) => /^(1[3-9]|[2-9]\d)-/.test(name));
  assert.deepEqual(migrationFiles, ["13-stage5-historical-olap-facts.sql"]);
});
