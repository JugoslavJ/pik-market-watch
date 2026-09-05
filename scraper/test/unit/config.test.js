"use strict";
// Unit tests for config.js: search-key normalization in-process;
// searches-file loading via subprocesses (config resolves at require time).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeSearchKey } = require("../../src/config");

const CONFIG_PATH = path.resolve(__dirname, "..", "..", "src", "config.js");

test("normalizeSearchKey: strips page, olx_scrape and hash", () => {
  assert.equal(
    normalizeSearchKey(
      "https://olx.ba/pretraga?category_id=23&canton=11&page=3&olx_scrape=1&cities=79#results",
    ),
    "/pretraga?category_id=23&canton=11&cities=79",
  );
});

test("normalizeSearchKey: host is irrelevant — www and bare URLs share a key", () => {
  assert.equal(
    normalizeSearchKey("https://www.olx.ba/pretraga?kat=16"),
    normalizeSearchKey("https://olx.ba/pretraga?kat=16"),
  );
});

test("normalizeSearchKey: keeps param order stable (URLSearchParams preserves insertion)", () => {
  assert.equal(
    normalizeSearchKey("https://olx.ba/pretraga?a=1&b=2"),
    "/pretraga?a=1&b=2",
  );
});

// ── loadSearches precedence + derivation, exercised in subprocesses ──────────

function runWith(envOverrides, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olx-cfg-"));
  const file = path.join(dir, "searches.json");
  if (fixture) fs.writeFileSync(file, JSON.stringify(fixture));
  const script = `
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify(cfg.searches));
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      ...envOverrides,
      SEARCHES_FILE: fixture ? file : "",
    },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out);
}

function runConfigFailure(envOverrides, fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olx-cfg-invalid-"));
  const file = path.join(dir, "searches.json");
  if (fixture !== undefined) fs.writeFileSync(file, fixture);
  const script = `require(${JSON.stringify(CONFIG_PATH)});`;
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, ["-e", script], {
          env: {
            ...process.env,
            ...envOverrides,
            SEARCHES_FILE: fixture !== undefined ? file : "",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (error) => {
        error.message += ` ${error.stderr?.toString() || ""}`;
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSearches: name kept, category trimmed, page stripped from key", () => {
  const [s] = runWith(
    {},
    {
      searches: [
        {
          name: "Stanovi BL",
          category: "  apartments  ",
          url: "https://olx.ba/pretraga?category_id=23&page=4",
        },
      ],
    },
  );
  assert.deepEqual(s, {
    name: "Stanovi BL",
    category: "apartments",
    url: "https://olx.ba/pretraga?category_id=23&page=4",
    searchKey: "/pretraga?category_id=23",
  });
});

test("loadSearches: duplicate URLs collapse to one search (first wins)", () => {
  const searches = runWith(
    {},
    {
      searches: [
        { url: "https://olx.ba/pretraga?category_id=23", name: "first" },
        {
          url: "https://olx.ba/pretraga?category_id=23&page=2&olx_scrape=1",
          name: "dup",
        },
      ],
    },
  );
  assert.equal(searches.length, 1);
  assert.equal(searches[0].name, "first");
  assert.equal(searches[0].searchKey, "/pretraga?category_id=23");
});

test("loadSearches: missing name/category → derived name, null category", () => {
  const [s] = runWith(
    {},
    {
      searches: [{ url: "https://olx.ba/pretraga?kat=16" }],
    },
  );
  assert.equal(s.name, "pretraga");
  assert.equal(s.category, null);
});

test("loadSearches: empty category string becomes null", () => {
  const [s] = runWith(
    {},
    { searches: [{ name: "X", category: "   ", url: "https://olx.ba/a" }] },
  );
  assert.equal(s.category, null);
});

test("loadSearches: SEARCH_URLS env overrides the file entirely", () => {
  const [s] = runWith(
    { SEARCH_URLS: "https://olx.ba/pretraga?kat=17" },
    {
      searches: [{ name: "ignored", url: "https://olx.ba/ignored" }],
    },
  );
  assert.equal(s.name, "pretraga");
  assert.equal(s.category, null);
  assert.equal(s.searchKey, "/pretraga?kat=17");
});

test("numeric configuration rejects zero concurrency and numeric prefixes", () => {
  runConfigFailure({ CONCURRENCY: "0" });
  runConfigFailure({ API_TIMEOUT_MS: "20ms" });
});

test("numeric configuration enforces bounded ports and positive intervals", () => {
  runConfigFailure({ HEALTH_PORT: "65536" });
  runConfigFailure({ SCRAPE_INTERVAL_MINUTES: "-1" });
});

test("migration startup fallback accepts explicit boolean values", () => {
  const script = `
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify(cfg.migrationsOnStartup));
  `;
  const out = execFileSync(process.execPath, ["-e", script], {
    env: { ...process.env, MIGRATIONS_ON_STARTUP: "0", SEARCHES_FILE: "" },
    encoding: "utf8",
  });
  assert.equal(out, "false");
});

test("migration startup fallback defaults to enabled outside Compose", () => {
  const script = `
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify(cfg.migrationsOnStartup));
  `;
  const env = { ...process.env, SEARCHES_FILE: "" };
  delete env.MIGRATIONS_ON_STARTUP;
  const out = execFileSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
  });
  assert.equal(out, "true");
});

test("migration startup fallback rejects ambiguous values", () => {
  runConfigFailure({ MIGRATIONS_ON_STARTUP: "sometimes" });
});

test("an existing malformed searches file fails loudly", () => {
  runConfigFailure({}, "{ definitely not json }");
});
