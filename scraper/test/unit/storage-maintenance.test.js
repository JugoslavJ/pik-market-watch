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
    calls[0][1][6],
    null,
    "derived search adapter is not duplicated",
  );
  assert.deepEqual(
    calls[0][1][7],
    JSON.stringify({ data: [{ id: 1 }], meta: { total: 1 } }),
  );
  assert.equal(calls[0][1][12], "canonical-v2");
  assert.match(calls[0][0], /INSERT INTO raw_api_response_pending/);
  assert.match(calls[0][0], /parser_version, payload, source_payload/);
  assert.match(calls[1][0], /INSERT INTO raw_api_response_pending/);
  assert.equal(calls[1][1][6], null, "diagnostics do not retain an empty body");
  assert.equal(calls[1][1][12], "diagnostic-v2");
});

test("raw response purge ranks records per request stream", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.rawResponseRetentionCount = 3;
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      return { rowCount: 0, rows: [] };
    },
  };

  assert.equal(await db.purgeRawResponses(), 0);
  assert.match(calls[0][0], /PARTITION BY request_kind, request_url/);
  assert.deepEqual(calls[0][1], [3, 1000]);
});

test("lean raw archive stores listing and run references in lean", async () => {
  const db = new Db("postgres://unused", { schema: "lean" });
  const calls = [];
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      return String(args[0]).includes("to_regclass")
        ? { rows: [{ ready: true }] }
        : { rowCount: 1 };
    },
  };

  await db.archiveSearchResponse({
    runId: 81,
    articleId: 82,
    requestKind: "detail",
    requestUrl: "https://olx.ba/api/listings/82",
    payload: { id: 82 },
  });

  assert.match(calls[1][0], /INSERT INTO lean\.raw_api_responses/);
  assert.deepEqual(calls[1][1].slice(0, 2), [81, 82]);
});

test("lean raw archive retention never calls legacy public storage helpers", async () => {
  const db = new Db("postgres://unused", { schema: "lean" });
  const calls = [];
  db.rawResponseRetentionCount = 3;
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      return String(args[0]).includes("to_regclass")
        ? { rows: [{ ready: true }] }
        : { rowCount: 0, rows: [{ deleted: 0 }] };
    },
  };

  const result = await db.runMaintenanceCycle();

  assert.equal(result.ok, true);
  assert.equal(result.purged, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1][0], /FROM lean\.raw_api_responses/);
  assert.doesNotMatch(calls[1][0], /public\./);
});

test("lean raw archive remains compatible before its data migration", async () => {
  const db = new Db("postgres://unused", { schema: "lean" });
  let insert;
  db.pool = {
    query: async (sql, values) => {
      if (String(sql).includes("to_regclass"))
        return { rows: [{ ready: false }] };
      insert = { sql, values };
      return { rowCount: 1 };
    },
  };

  await db.archiveSearchResponse({
    runId: 91,
    articleId: 92,
    requestUrl: "https://olx.ba/api/search?page=1",
    payload: { data: [] },
  });

  assert.match(insert.sql, /INSERT INTO public\.raw_api_response_pending/);
  assert.deepEqual(insert.values.slice(0, 2), [null, null]);
  assert.deepEqual(JSON.parse(insert.values[8]), {
    leanRunId: 91,
    leanArticleId: 92,
  });
});

test("batched detail archives keep original bodies and bodyless diagnostics", async () => {
  const db = new Db("postgres://unused");
  let archived;
  let archiveSql;
  db.pool = {
    query: async (sql, [encoded]) => {
      archiveSql = sql;
      archived = JSON.parse(encoded);
      return { rowCount: archived.length };
    },
  };
  const count = await db.archiveDetailResponses([
    { articleId: 1, payload: { adapted: true }, sourcePayload: { id: 1 } },
    {
      articleId: 2,
      payload: { id: 2 },
      sourcePayload: { id: 2 },
      diagnostic: { kind: "http", status: 403 },
    },
  ]);
  assert.equal(count, 2);
  assert.match(archiveSql, /INSERT INTO raw_api_response_pending/);
  assert.match(archiveSql, /parser_version, payload, source_payload/);
  assert.deepEqual(archived[0].payload, { id: 1 });
  assert.equal(archived[1].payload, null);
  assert.deepEqual(archived[1].diagnostic, { kind: "http", status: 403 });
});

test("maintenance attempts purge and rebuild independently", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.purgeRawResponses = async () => {
    calls.push("purge");
    throw new Error("purge unavailable");
  };
  db.rebuildDailyInventory = async () => {
    calls.push("rebuild");
    throw new Error("rebuild unavailable");
  };
  db.analyzeAnalyticsPartitions = async () => ({ analyzed: 0 });
  db.recordMaintenanceOutcome = async () => {};

  const result = await db.runMaintenanceCycle();
  assert.deepEqual(calls, ["purge", "rebuild"]);
  assert.equal(result.ok, false);
  assert.match(result.errors.purged, /purge unavailable/);
  assert.match(result.errors.rebuilt, /rebuild unavailable/);
});

test("maintenance excludes synchronous current-market publication", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.refreshCurrentMarket = async () => calls.push("publish");
  db.purgeRawResponses = async () => 0;
  db.rebuildDailyInventory = async () => ({ rows: [{ rows_written: 1 }] });
  db.analyzeAnalyticsPartitions = async () => ({ analyzed: 0 });
  db.recordMaintenanceOutcome = async () => {};

  await db.runMaintenanceCycle();
  assert.deepEqual(calls, []);
});

test("maintenance logs stage and current-market substep timings", async () => {
  const db = new Db("postgres://unused");
  const logs = [];
  db.pool = {
    query: async (sql) =>
      String(sql).includes("refresh_current_market")
        ? { rows: [{ rows_written: 4 }] }
        : { rows: [] },
  };
  await db.refreshCurrentMarket((message) => logs.push(message));
  assert.match(logs[0], /^starting currentMarket\/olapRefresh$/);
  assert.match(
    logs[1],
    /^currentMarket\/olapRefresh completed in \d+\.\d{2}s$/,
  );
  assert.deepEqual(
    logs
      .filter((message) => message.startsWith("starting currentMarket/"))
      .map((message) => message.replace(/^starting /, "")),
    [
      "currentMarket/olapRefresh",
      "currentMarket/ensureAnalyticsPartitions",
      "currentMarket/operationalCleanup",
      "currentMarket/validateContracts",
      "currentMarket/analyzePublishedOlap",
    ],
  );
});
