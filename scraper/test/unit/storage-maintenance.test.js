"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/db");

test("raw archive v2 stores one canonical search body and keeps diagnostics bodyless", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = { query: async (...args) => (calls.push(args), { rowCount: 1 }) };

  await db.archiveSearchResponse({
    requestUrl: "https://olx.ba/api/search?page=1",
    payload: { items: [{ id: 1 }] },
    sourcePayload: { data: [{ id: 1 }], meta: { total: 1 } },
  });
  await db.archiveResponseDiagnostic({
    requestUrl: "https://olx.ba/api/search?page=2",
    error: new Error("blocked"),
  });

  assert.equal(
    calls[0][1][7],
    null,
    "derived search adapter is not duplicated",
  );
  assert.deepEqual(
    calls[0][1][8],
    JSON.stringify({ data: [{ id: 1 }], meta: { total: 1 } }),
  );
  assert.equal(calls[0][1][13], "canonical-v2");
  assert.equal(calls[1][1][7], null, "diagnostics do not retain an empty body");
  assert.equal(calls[1][1][13], "diagnostic-v2");
});

test("maintenance attempts purge and rebuild independently", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.backfillPublicationEvidence = async () => ({ complete: true });
  db.backfillPublicationEvidenceFromRaw = async () => ({ complete: true });
  db.transitionRawResponseRetention = async () => ({ complete: true });
  db.compactDuplicateRawBodies = async () => 2;
  db.purgeRawResponses = async () => {
    calls.push("purge");
    throw new Error("purge unavailable");
  };
  db.rebuildDailyInventory = async () => {
    calls.push("rebuild");
    throw new Error("rebuild unavailable");
  };
  db.recordMaintenanceOutcome = async () => {};

  const result = await db.runMaintenanceCycle();
  assert.deepEqual(calls, ["purge", "rebuild"]);
  assert.equal(result.ok, false);
  assert.match(result.errors.purged, /purge unavailable/);
  assert.match(result.errors.rebuilt, /rebuild unavailable/);
});
