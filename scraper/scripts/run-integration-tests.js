#!/usr/bin/env node
"use strict";
// Runs the DB-backed integration tests against a throwaway canonical PostGIS
// container. Requires Docker. Usage: npm run test:integration
//
//   1. removes any stale olx-pg-test container
//   2. starts the pinned PostGIS/PostgreSQL 18 image with db/init mounted
//      as Docker's canonical bootstrap on TEST_DB_PORT
//      (default 55432)
//   3. waits until it accepts connections
//   4. verifies the canonical bootstrap contract
//   5. runs each `node --test test/integration/<file>` child with TEST_DATABASE_URL set
//   6. always removes the container again

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const NAME = "olx-pg-test";
const PORT = process.env.TEST_DB_PORT || "55432";
const INIT_DIR = path.resolve(__dirname, "..", "..", "db", "init");
const IMAGE =
  process.env.TEST_POSTGRES_IMAGE ||
  "ghcr.io/baosystems/postgis:18-3.6@sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8";
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
    // Synchronous 1 s pause without spawning a process: Windows timeout.exe
    // refuses to run under execSync ("input redirection not supported").
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error("test postgres did not become ready in time");
}

let exit;
docker(["rm", "-f", NAME]); // stale container from a crashed run
const up = docker([
  "run",
  "-d",
  "--name",
  NAME,
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
  "-p",
  `${PORT}:5432`,
  "-v",
  `${INIT_DIR}:/docker-entrypoint-initdb.d:ro`,
  IMAGE,
]);
if (up.status !== 0) {
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
    "SELECT to_regclass('public.listing_state_versions') IS NOT NULL " +
      "AND to_regclass('reporting.current_comparison_inputs') IS NOT NULL " +
      "AND to_regprocedure('reporting.refresh_dashboard_olap(boolean)') IS NOT NULL;",
  ]);
  if (contract.status !== 0 || contract.stdout.trim() !== "t") {
    throw new Error(
      `canonical database bootstrap contract failed: ${contract.stderr || contract.stdout}`,
    );
  }

  // Keep each file in its own process. Node's test-concurrency flag limits
  // worker scheduling but does not prevent independent files from sharing a
  // database while their beforeEach resets are running. A fresh child per
  // file makes the single disposable database deterministic on all Node
  // versions and platforms.
  const files = fs
    .readdirSync(path.resolve("test", "integration"))
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
  for (const file of files) {
    const testArgs = ["--test", "--test-concurrency=1"];
    if (process.env.TEST_NAME_PATTERN) {
      testArgs.push(`--test-name-pattern=${process.env.TEST_NAME_PATTERN}`);
    }
    testArgs.push(path.join("test", "integration", file));
    const r = spawnSync(process.execPath, testArgs, {
      stdio: "inherit",
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
  docker(["rm", "-f", NAME]);
}
process.exit(exit);
