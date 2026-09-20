#!/usr/bin/env node
"use strict";
// Runs the DB-backed integration tests against a throwaway PostgreSQL
// container. Requires Docker. Usage: npm run test:integration
//
//   1. removes any stale olx-pg-test container
//   2. starts the pinned PostGIS/PostgreSQL 16 image on TEST_DB_PORT
//      (default 55432)
//   3. waits until it accepts connections
//   4. runs each `node --test test/integration/<file>` child with TEST_DATABASE_URL set
//   5. always removes the container again

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const NAME = "olx-pg-test";
const PORT = process.env.TEST_DB_PORT || "55432";
const IMAGE =
  process.env.TEST_POSTGRES_IMAGE ||
  "ghcr.io/baosystems/postgis:16-3.5@sha256:0f1c5c0f70f03d4d19ad1d7308d86e6162dff5429c491002298a7b5e46d2f2e8";
const DB_URL = `postgres://olx:olx@localhost:${PORT}/olx`;

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
  "-p",
  `${PORT}:5432`,
  IMAGE,
]);
if (up.status !== 0) {
  console.error(up.stderr);
  process.exit(1);
}

try {
  waitUntilReady();
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
    const r = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        path.join("test", "integration", file),
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          TEST_DATABASE_URL: DB_URL,
          TEST_DATABASE_CONTAINER: NAME,
          ...(schemaReady ? { TEST_DATABASE_SCHEMA_READY: "1" } : {}),
        },
      },
    );
    if ((r.status ?? 1) !== 0) {
      exit = r.status ?? 1;
      break;
    }
    schemaReady = true;
  }
} finally {
  docker(["rm", "-f", NAME]);
}
process.exit(exit);
