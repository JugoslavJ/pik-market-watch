"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/client");

function leaseDb(query) {
  const db = new Db("postgres://unused");
  const releases = [];
  db.pool = {
    connect: async () => ({
      query,
      release: (error) => releases.push(error),
    }),
  };
  return { db, releases };
}

for (const method of [
  "tryAcquireCycleLease",
  "tryAcquireLeanMaintenanceLease",
]) {
  test(`${method}: contention returns the connection immediately`, async () => {
    const { db, releases } = leaseDb(async () => ({
      rows: [{ acquired: false }],
    }));
    assert.equal(await db[method](), null);
    assert.deepEqual(releases, [undefined]);
  });

  test(`${method}: the lease holds its connection until released once`, async () => {
    const queries = [];
    const { db, releases } = leaseDb(async (sql, params) => {
      queries.push([sql, params]);
      return { rows: [{ acquired: true }] };
    });
    const lease = await db[method]();
    assert.deepEqual(releases, []);
    await lease.release();
    await lease.release();
    assert.deepEqual(releases, [undefined]);
    assert.equal(queries.length, 2);
    assert.match(queries[0][0], /pg_try_advisory_lock/);
    assert.match(queries[1][0], /pg_advisory_unlock/);
    assert.deepEqual(queries[0][1], queries[1][1]);
  });

  test(`${method}: failed acquisition discards the connection`, async () => {
    const error = new Error("connection lost while acquiring lock");
    const { db, releases } = leaseDb(async () => {
      throw error;
    });
    await assert.rejects(db[method](), error);
    assert.deepEqual(releases, [error]);
  });

  test(`${method}: failed unlock discards the session and release stays idempotent`, async () => {
    const error = new Error("connection lost while releasing lock");
    const { db, releases } = leaseDb(async (sql) => {
      if (sql.includes("pg_advisory_unlock")) throw error;
      return { rows: [{ acquired: true }] };
    });
    const lease = await db[method]();
    await assert.rejects(lease.release(), error);
    await lease.release();
    assert.deepEqual(releases, [error]);
  });
}
