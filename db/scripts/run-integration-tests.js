#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const NAME = `pik-pg-test-${process.pid}`;
const REPORTING_ONLY = process.argv.includes("--reporting-only");
// --with-reporting runs the integration files, then the reporting suite, on one database.
const REPORTING = REPORTING_ONLY || process.argv.includes("--with-reporting");
const NETWORK = `${NAME}-network`;
const PORT = process.env.TEST_DB_PORT || "55432";
const DB_DIR = path.resolve(__dirname, "..");
const INIT_DIR = path.join(DB_DIR, "init-lean");
// Reuse the database image pinned in Compose so tests never pull a second copy.
function composeDatabaseImage() {
  const compose = fs.readFileSync(
    path.join(DB_DIR, "..", "docker-compose.yml"),
    "utf8",
  );
  const image = compose.match(
    /^ {4}image: (ghcr\.io\/baosystems\/postgis:\S+)$/m,
  );
  if (!image) throw new Error("docker-compose.yml pins no PostGIS image");
  return image[1];
}
const IMAGE = process.env.TEST_POSTGRES_IMAGE || composeDatabaseImage();
const DB_URL = `postgres://olx:olx@127.0.0.1:${PORT}/olx`;

const docker = (args, opts = {}) =>
  spawnSync("docker", args, { encoding: "utf8", ...opts });

function waitUntilReady() {
  for (let i = 1; i <= 60; i++) {
    // The entrypoint's temporary bootstrap server accepts socket connections
    // before initialization finishes. Wait for the final TCP listener instead.
    const r = docker([
      "exec",
      NAME,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "olx",
      "-d",
      "olx",
    ]);
    if (r.status === 0) return;
    // Atomics.wait also works under redirected input on Windows.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error("test postgres did not become ready in time");
}

let exit;
if (REPORTING) {
  const network = docker(["network", "create", NETWORK]);
  if (network.status !== 0) throw new Error(network.stderr);
}
const up = docker([
  "run",
  "-d",
  "--name",
  NAME,
  ...(REPORTING ? ["--network", NETWORK] : []),
  "-e",
  "POSTGRES_USER=olx",
  "-e",
  "POSTGRES_PASSWORD=olx",
  "-e",
  "POSTGRES_DB=olx",
  "-e",
  "POSTGRES_MIGRATOR_PASSWORD=integration-migrator",
  "-e",
  "POSTGRES_APP_PASSWORD=integration-app",
  "-e",
  "POSTGRES_REPORTING_PASSWORD=integration-reporting",
  "-e",
  "POSTGRES_BACKUP_PASSWORD=integration-backup",
  "-e",
  "SUPERSET_META_PASSWORD=integration-superset",
  "-p",
  `${PORT}:5432`,
  "-v",
  `${INIT_DIR}:/docker-entrypoint-initdb.d:ro`,
  IMAGE,
]);
if (up.status !== 0) {
  // A failed port bind still leaves a created container behind.
  docker(["rm", "-f", "-v", NAME]);
  if (REPORTING) docker(["network", "rm", NETWORK]);
  console.error(up.stderr);
  process.exit(1);
}

try {
  waitUntilReady();
  const contract = docker([
    "exec",
    NAME,
    "psql",
    "-Atq",
    "-U",
    "olx",
    "-d",
    "olx",
    "-c",
    "SELECT to_regclass('lean.listings') IS NOT NULL " +
      "AND to_regclass('lean.listing_lifecycle_events') IS NOT NULL " +
      "AND to_regclass('lean.raw_api_responses') IS NOT NULL " +
      "AND to_regclass('lean.scrape_run_pages') IS NOT NULL " +
      "AND to_regclass('olap.refresh_state') IS NULL;",
  ]);
  if (contract.status !== 0 || contract.stdout.trim() !== "t") {
    throw new Error(
      `canonical database bootstrap contract failed: ${contract.stderr || contract.stdout}`,
    );
  }

  // Run files sequentially so their database resets cannot race.
  const files = fs
    .readdirSync(path.join(DB_DIR, "test", "integration"))
    .filter((file) => file.endsWith(".test.js"))
    .filter(
      (file) =>
        !process.env.TEST_FILE_PATTERN ||
        new RegExp(process.env.TEST_FILE_PATTERN).test(file),
    )
    .sort();
  if (files.length === 0) throw new Error("no integration test files matched");
  exit = 0;
  let schemaReady = false;
  for (const file of REPORTING_ONLY ? [] : files) {
    const testArgs = ["--test", "--test-concurrency=1"];
    if (process.env.TEST_NAME_PATTERN) {
      testArgs.push(`--test-name-pattern=${process.env.TEST_NAME_PATTERN}`);
    }
    testArgs.push(path.join("test", "integration", file));
    const r = spawnSync(process.execPath, testArgs, {
      stdio: "inherit",
      cwd: DB_DIR,
      env: {
        ...process.env,
        TEST_DATABASE_URL: DB_URL,
        TEST_DATABASE_CONTAINER: NAME,
        ...(schemaReady ? { TEST_DATABASE_SCHEMA_READY: "1" } : {}),
      },
    });
    if ((r.status ?? 1) !== 0) {
      exit = r.status ?? 1;
      break;
    }
    schemaReady = true;
  }
  if (REPORTING && exit === 0) {
    const root = path.resolve(DB_DIR, "..");
    const result = docker(
      [
        "run",
        "--rm",
        "--network",
        NETWORK,
        "-v",
        `${path.join(root, "superset")}:/assets:ro`,
        "-e",
        `TEST_REPORTING_DATABASE_URL=postgresql://olx_reporting:integration-reporting@${NAME}:5432/olx`,
        "-e",
        `TEST_SEED_DATABASE_URL=postgresql://olx:olx@${NAME}:5432/olx`,
        "--entrypoint",
        "python",
        process.env.TEST_SUPERSET_IMAGE || "pik-market-watch-superset:ci",
        "-m",
        "unittest",
        "discover",
        "-v",
        "-s",
        "/assets/tests",
        "-p",
        "test_reporting.py",
      ],
      { stdio: "inherit" },
    );
    exit = result.status ?? 1;
  }
} finally {
  if (exit !== 0) {
    const logs = docker(["logs", NAME]);
    if (logs.stdout.trim()) {
      console.error("\n--- disposable PostgreSQL logs ---");
      console.error(logs.stdout.trim().split(/\r?\n/).slice(-120).join("\n"));
    }
    if (logs.stderr.trim()) {
      console.error(logs.stderr.trim().split(/\r?\n/).slice(-120).join("\n"));
    }
  }
  docker(["rm", "-f", "-v", NAME]);
  if (REPORTING) docker(["network", "rm", NETWORK]);
}
process.exit(exit);
