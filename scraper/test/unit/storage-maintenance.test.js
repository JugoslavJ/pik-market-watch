"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/db");

function leanPool(calls, queryResult = { rowCount: 1 }) {
  return {
    query: async (...args) => {
      calls.push(args);
      if (String(args[0]).includes("to_regclass"))
        return { rows: [{ ready: true }] };
      return queryResult;
    },
  };
}

test("raw archive writes canonical search payloads and bodyless diagnostics to lean", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = leanPool(calls);

  await db.archiveSearchResponse({
    runId: 81,
    articleId: 82,
    requestUrl: "https://olx.ba/api/search?page=1",
    payload: { items: [{ id: 1 }] },
    sourcePayload: { data: [{ id: 1 }], meta: { total: 1 } },
  });
  await db.archiveResponseDiagnostic({
    requestUrl: "https://olx.ba/api/search?page=2",
    error: new Error("blocked"),
  });

  assert.match(calls[1][0], /INSERT INTO lean\.raw_api_responses/);
  assert.deepEqual(calls[1][1].slice(0, 2), [81, 82]);
  assert.equal(calls[1][1][6], null);
  assert.deepEqual(JSON.parse(calls[1][1][7]), {
    data: [{ id: 1 }],
    meta: { total: 1 },
  });
  assert.equal(calls[1][1][12], "canonical-v2");
  assert.match(calls[2][0], /INSERT INTO lean\.raw_api_responses/);
  assert.equal(calls[2][1][6], null);
  assert.equal(calls[2][1][12], "diagnostic-v2");
});

test("raw response retention purges the lean archive by request stream", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.rawResponseRetentionCount = 3;
  db.pool = leanPool(calls, { rowCount: 0, rows: [{ deleted: 0 }] });

  assert.equal(await db.purgeRawResponses(), 0);
  assert.match(calls[1][0], /FROM lean\.raw_api_responses/);
  assert.match(calls[1][0], /PARTITION BY request_kind,request_url/);
  assert.deepEqual(calls[1][1], [3, 1000]);
});

test("batched detail archives keep source bodies and bodyless diagnostics", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = leanPool(calls, { rowCount: 2 });

  const count = await db.archiveDetailResponses([
    { articleId: 1, payload: { adapted: true }, sourcePayload: { id: 1 } },
    {
      articleId: 2,
      payload: { id: 2 },
      diagnostic: { kind: "http", status: 403 },
    },
  ]);
  const rows = JSON.parse(calls[1][1][0]);
  assert.equal(count, 2);
  assert.match(calls[1][0], /INSERT INTO lean\.raw_api_responses/);
  assert.deepEqual(rows[0].payload, { id: 1 });
  assert.equal(rows[1].payload, null);
  assert.deepEqual(rows[1].diagnostic, { kind: "http", status: 403 });
});

test("lean archive absence fails explicitly without falling back to public", async () => {
  const db = new Db("postgres://unused");
  db.pool = { query: async () => ({ rows: [{ ready: false }] }) };
  await assert.rejects(
    db.rawArchiveTarget(),
    /lean\.raw_api_responses is not installed/,
  );
});
