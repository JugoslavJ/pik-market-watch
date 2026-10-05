"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const CONFIG_PATH = path.resolve(__dirname, "../../src/config.js");

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

test("database configuration ignores invalid collection settings and saved searches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "olx-db-config-"));
  const file = path.join(dir, "searches.json");
  fs.writeFileSync(file, "{ invalid json }");
  try {
    const script = `
      const cfg = require(${JSON.stringify(CONFIG_PATH)});
      process.stdout.write(JSON.stringify({
        retention: cfg.rawResponseRetentionCount,
        migrationsDir: cfg.migrationsDir,
      }));
    `;
    const output = JSON.parse(
      execFileSync(process.execPath, ["-e", script], {
        env: {
          ...process.env,
          SEARCHES_FILE: file,
          CONCURRENCY: "0",
          API_TIMEOUT_MS: "invalid",
          RAW_RESPONSE_RETENTION_COUNT: "5",
        },
        encoding: "utf8",
      }),
    );
    assert.equal(output.retention, 5);
    assert.ok(fs.existsSync(output.migrationsDir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("database retention configuration rejects zero and numeric prefixes", () => {
  runConfigFailure({ RAW_RESPONSE_RETENTION_COUNT: "0" });
  runConfigFailure({ RAW_RESPONSE_RETENTION_COUNT: "3rows" });
});
