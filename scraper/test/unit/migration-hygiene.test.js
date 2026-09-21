"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const init = path.resolve(__dirname, "../../../db/init");
const allowlistedHistoryBackfills = new Set();

test("forward migrations do not UPDATE append-only history or daily tables", () => {
  const violations = [];
  for (const file of fs
    .readdirSync(init)
    .filter((name) => /^3\d-.*\.sql$/.test(name))) {
    const sql = fs.readFileSync(path.join(init, file), "utf8");
    for (const match of sql.matchAll(
      /\bUPDATE\s+(?:public\.)?(listing_state_history|listing_daily)\b/gi,
    )) {
      if (!allowlistedHistoryBackfills.has(file))
        violations.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(violations, []);
});
