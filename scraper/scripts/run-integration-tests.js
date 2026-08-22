#!/usr/bin/env node
'use strict';
// Runs the DB-backed integration tests against a throwaway PostgreSQL
// container. Requires Docker. Usage: npm run test:integration
//
//   1. removes any stale olx-pg-test container
//   2. starts postgres:16-alpine on TEST_DB_PORT (default 55432)
//   3. waits until it accepts connections
//   4. runs `node --test test/integration/` with TEST_DATABASE_URL set
//   5. always removes the container again

const { spawnSync } = require('node:child_process');

const NAME = 'olx-pg-test';
const PORT = process.env.TEST_DB_PORT || '55432';
const DB_URL = `postgres://olx:olx@localhost:${PORT}/olx`;

const docker = (args, opts = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', ...opts });

function waitUntilReady() {
  for (let i = 1; i <= 60; i++) {
    const r = docker(['exec', NAME, 'pg_isready', '-U', 'olx', '-d', 'olx']);
    if (r.status === 0) return;
    require('node:child_process').execSync(
      process.platform === 'win32' ? 'timeout /t 1 /nobreak >nul' : 'sleep 1');
  }
  throw new Error('test postgres did not become ready in time');
}

let exit = 1;
docker(['rm', '-f', NAME]);                              // stale container from a crashed run
const up = docker(['run', '-d', '--name', NAME,
  '-e', 'POSTGRES_USER=olx', '-e', 'POSTGRES_PASSWORD=olx', '-e', 'POSTGRES_DB=olx',
  '-p', `${PORT}:5432`, 'postgres:16-alpine']);
if (up.status !== 0) {
  console.error(up.stderr);
  process.exit(1);
}

try {
  waitUntilReady();
  const r = spawnSync(process.execPath,
    // Node ≥24 dropped directory args for --test — pass an explicit glob
    // (the runner resolves it itself, so this stays Windows-safe).
    ['--test', '--test-concurrency=1', 'test/integration/*.test.js'],   // files share one DB → serialize
    { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DB_URL } });
  exit = r.status ?? 1;
} finally {
  docker(['rm', '-f', NAME]);
}
process.exit(exit);
