"use strict";
// Unit tests for api.js response-body capping: readBodyCapped concatenates
// small streams verbatim, throws ApiError past the cap, and tolerates
// exactly-at-cap bodies.
const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_BODY_BYTES, readBodyCapped } = require("../../src/api");

// Minimal fetch-Response stand-in whose body is a REAL web ReadableStream
// (same interface undici hands fetchJson), plus header lookup.
function fakeResponse(chunks, headers = {}) {
  return {
    body: new Blob(chunks).stream(),
    text: () => Promise.resolve(chunks.join("")),
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

test("readBodyCapped: small multi-chunk body passes through byte-for-byte", async () => {
  const res = fakeResponse(["hello ", "olx"]);
  assert.equal(await readBodyCapped(res, MAX_BODY_BYTES), "hello olx");
});

test("readBodyCapped: empty body → empty string", async () => {
  assert.equal(await readBodyCapped(fakeResponse([]), 1024), "");
});

test("readBodyCapped: stream crossing the cap aborts with ApiError", async () => {
  const half = "a".repeat(600); // two chunks = 1200 > the 1024 cap below
  const res = fakeResponse([half, half]);
  await assert.rejects(
    () => readBodyCapped(res, 1024),
    (err) => err.name === "ApiError" && /exceeds 1024 bytes/.test(err.message),
  );
});

test("readBodyCapped: body exactly at the cap succeeds", async () => {
  const exact = "b".repeat(64);
  assert.equal(await readBodyCapped(fakeResponse([exact]), 64), exact);
});

test("readBodyCapped: missing stream falls back to res.text()", async () => {
  const res = { body: null, text: () => Promise.resolve("fallback") };
  assert.equal(await readBodyCapped(res, 1024), "fallback");
});

test("MAX_BODY_BYTES keeps its sane 5 MiB ceiling", () => {
  assert.equal(MAX_BODY_BYTES, 5 * 1024 * 1024);
});
