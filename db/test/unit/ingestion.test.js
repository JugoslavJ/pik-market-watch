"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { commitSearchIngestion, computeMedian } = require("../../src/ingestion");

test("computeMedian sorts input, rounds even-sized medians and returns null without priced data", () => {
  assert.equal(computeMedian([]), null);
  assert.equal(computeMedian([3000, 1000, 2000]), 2000);
  assert.equal(computeMedian([1800, 2000]), 1900);
  assert.equal(computeMedian([1000, 1001]), 1001);
  assert.equal(computeMedian([5000, 1000, 3000, 2000]), 2500);
});

test("ingestion deduplicates numeric IDs with the last card winning and rejects invalid IDs", async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push([sql, params]);
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const cards = Object.freeze(
    [
      { articleId: "2", title: "old" },
      { articleId: 1, title: "first" },
      { articleId: "02", title: "latest" },
      { articleId: Number.MAX_SAFE_INTEGER, title: "large" },
      ...[
        0,
        -1,
        1.5,
        "bad",
        "",
        null,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ].map((articleId) => ({ articleId, title: "invalid" })),
    ].map(Object.freeze),
  );
  const result = await commitSearchIngestion.call(
    { pool: { connect: async () => client } },
    {
      cards,
      runId: 1,
      search: { searchKey: "search", name: "Search", url: "https://olx.ba" },
    },
  );
  const insert = calls.find(([sql]) =>
    sql.includes("INSERT INTO lean.listings"),
  );
  const observations = JSON.parse(insert[1][0]);
  assert.deepEqual(
    observations.map(({ article_id, title }) => ({ article_id, title })),
    [
      { article_id: 2, title: "latest" },
      { article_id: 1, title: "first" },
      { article_id: Number.MAX_SAFE_INTEGER, title: "large" },
    ],
  );
  assert.deepEqual(result.newIds, [2, 1, Number.MAX_SAFE_INTEGER]);
  assert.equal(result.newCount, 3);
  assert.equal(calls.at(-1)[0], "COMMIT");
  assert.equal(released, true);
});
