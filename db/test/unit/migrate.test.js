"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const applyMigrations = require("../../src/migrate");

test("migrationChecksum is a stable SHA-256 digest of UTF-8 SQL", () => {
  const expected =
    "4a45092ccf992ea92250053a80b931b787924ba61648f420555511b84f10ab6c";
  assert.equal(applyMigrations.migrationChecksum("select 1;\n"), expected);
  assert.equal(applyMigrations.migrationChecksum("select 1;\r\n"), expected);
});
