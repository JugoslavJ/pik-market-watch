const test = require("node:test");
const assert = require("node:assert/strict");

test("listing links accept HTTPS OLX hosts", async () => {
  const { validAd } = await import("../src/links.js");
  for (const url of [
    "https://olx.ba/artikal/123",
    "https://www.olx.ba/artikal/123",
    "https://m.olx.ba/artikal/123",
  ]) {
    assert.equal(validAd(url), true, url);
  }
});

test("listing links reject insecure, misleading and malformed destinations", async () => {
  const { validAd } = await import("../src/links.js");
  for (const url of [
    "http://olx.ba/artikal/123",
    "https://olx.ba.example.com",
    "https://fakeolx.ba",
    "https://olx.ba@evil.example",
    "javascript:alert(1)",
    "/artikal/123",
    "",
    null,
    undefined,
  ]) {
    assert.equal(validAd(url), false, String(url));
  }
});

test("listing navigation opens only approved links with isolated tab options", async (t) => {
  const { openAd } = await import("../src/links.js");
  const previous = globalThis.window;
  const calls = [];
  globalThis.window = { open: (...args) => calls.push(args) };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  openAd("https://olx.ba/artikal/123");
  openAd("https://olx.ba@evil.example");
  openAd(undefined);
  assert.deepEqual(calls, [
    ["https://olx.ba/artikal/123", "_blank", "noopener,noreferrer"],
  ]);
});
