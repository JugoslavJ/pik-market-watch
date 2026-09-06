"use strict";
// Unit tests for api.js response-body capping: readBodyCapped concatenates
// small streams verbatim, throws ApiError past the cap, and tolerates
// exactly-at-cap bodies.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_BODY_BYTES,
  readBodyCapped,
  fetchJson,
  fetchSearchPage,
  fetchListing,
  parseRetryAfter,
} = require("../../src/api");

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

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const source = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new Blob([source]).stream(),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

test("rate headers are null-aware when upstream omits them", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    jsonResponse({
      data: [],
      meta: { total: 0, last_page: 1, current_page: 1 },
    });
  try {
    const result = await fetchSearchPage(
      new URL("https://olx.ba/api/search"),
      100,
    );
    assert.equal(result.remaining, null);
    assert.equal(result.limit, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("off-origin API targets are rejected before fetch", async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    return jsonResponse({});
  };
  try {
    await assert.rejects(
      () => fetchJson(new URL("https://evil.example/api/search"), 100),
      (error) => error.name === "ApiError" && error.kind === "origin",
    );
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("API requests fail closed on redirects", async () => {
  const originalFetch = global.fetch;
  let options;
  global.fetch = async (_url, requestOptions) => {
    options = requestOptions;
    return jsonResponse({ ok: true });
  };
  try {
    await fetchJson(new URL("https://olx.ba/api/search"), 100);
    assert.equal(options.redirect, "error");
  } finally {
    global.fetch = originalFetch;
  }
});

test("listing IDs must be positive safe integers", async () => {
  for (const value of ["abc", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => fetchListing(value, 100),
      (error) => error.name === "ApiError" && error.kind === "input",
    );
  }
});

test("valid listing ID is used in the detail URL", async () => {
  const originalFetch = global.fetch;
  let requested;
  global.fetch = async (url) => {
    requested = String(url);
    return jsonResponse({ id: 42 });
  };
  try {
    assert.deepEqual(await fetchListing("42", 100), { id: 42 });
    assert.equal(requested, "https://olx.ba/api/listings/42");
  } finally {
    global.fetch = originalFetch;
  }
});

test("mismatched returned listing ID still fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ id: 43 });
  try {
    await assert.rejects(
      () => fetchListing(42, 100),
      /listing 42: unexpected payload shape/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("successful pages retain the decoded source body and transport metadata", async () => {
  const originalFetch = global.fetch;
  const source = {
    data: [{ id: 123 }],
    meta: { total: 1, last_page: 1, current_page: 1 },
  };
  global.fetch = async () =>
    jsonResponse(source, {
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "59",
      },
    });
  try {
    const result = await fetchSearchPage(
      new URL("https://olx.ba/api/search?page=1"),
      100,
    );
    assert.deepEqual(result.sourcePayload, source);
    assert.equal(result.requestMetadata.method, "GET");
    assert.equal(
      result.requestMetadata.url,
      "https://olx.ba/api/search?page=1",
    );
    assert.equal(result.responseMetadata.status, 200);
    assert.equal(result.responseMetadata.contentType, "application/json");
    assert.equal(result.responseMetadata.attempts, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("failed responses expose bounded diagnostics for durable archiving", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    jsonResponse("x".repeat(5000), {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  try {
    await assert.rejects(
      () =>
        fetchJson(new URL("https://olx.ba/api/search?category_id=23"), 100, {
          maxAttempts: 1,
        }),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.requestMetadata.method, "GET");
        assert.equal(error.responseMetadata.status, 503);
        assert.equal(error.diagnostic.kind, "http");
        assert.ok(error.diagnostic.body.length <= 2048);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("transient 429 honors Retry-After and retries once", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  const waits = [];
  global.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(
          { error: "slow down" },
          { status: 429, headers: { "retry-after": "2" } },
        )
      : jsonResponse({ ok: true });
  };
  try {
    const result = await fetchJson(new URL("https://olx.ba/api/search"), 100, {
      wait: async (ms) => waits.push(ms),
      random: () => 0,
    });
    assert.deepEqual(result.body, { ok: true });
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [2000]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a 200 HTML challenge is not blindly retried", async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      body: new Blob(["<html>challenge</html>"]).stream(),
      headers: { get: () => "text/html" },
    };
  };
  try {
    await assert.rejects(
      () => fetchJson(new URL("https://olx.ba/api/search"), 100),
      /non-JSON response/,
    );
    assert.equal(attempts, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Retry-After accepts HTTP dates and clamps old dates to zero", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter("Sat, 05 Sep 2026 12:00:02 GMT", now), 2000);
  assert.equal(parseRetryAfter("Sat, 05 Sep 2026 11:59:59 GMT", now), 0);
  assert.equal(parseRetryAfter("nonsense", now), null);
});
