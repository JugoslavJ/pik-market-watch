"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/client");

function leanPool(calls, queryResult = { rowCount: 1 }) {
  return {
    query: async (...args) => {
      calls.push(args);
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

  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /INSERT INTO lean\.raw_api_responses/);
  assert.deepEqual(calls[0][1].slice(0, 2), [81, 82]);
  assert.equal(calls[0][1][6], null);
  assert.deepEqual(JSON.parse(calls[0][1][7]), {
    data: [{ id: 1 }],
    meta: { total: 1 },
  });
  assert.equal(calls[0][1][12], "canonical-v2");
  assert.match(calls[1][0], /INSERT INTO lean\.raw_api_responses/);
  assert.equal(calls[1][1][6], null);
  assert.equal(calls[1][1][12], "diagnostic-v2");
});

test("raw response purge repeats full batches until one comes back short", async () => {
  const db = new Db("postgres://unused");
  const batches = [2, 2, 1];
  const calls = [];
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      return { rows: [{ deleted: batches.shift() }] };
    },
  };

  assert.equal(await db.purgeRawResponses(2), 5);
  assert.equal(calls.length, 3);
});

test("batched detail archives store source bodies", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = leanPool(calls, { rowCount: 2 });

  const count = await db.archiveDetailResponses([
    { articleId: 1, payload: { adapted: true }, sourcePayload: { id: 1 } },
    { articleId: 2, payload: { id: 2 } },
  ]);
  const rows = JSON.parse(calls[0][1][0]);
  assert.equal(count, 2);
  assert.match(calls[0][0], /INSERT INTO lean\.raw_api_responses/);
  assert.deepEqual(rows[0].payload, { id: 1 });
  assert.deepEqual(rows[1].payload, { id: 2 });
});
