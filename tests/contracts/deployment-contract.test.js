"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const deploy = fs.readFileSync(
  path.join(ROOT, "scripts", "deploy-stack.sh"),
  "utf8",
);

test("Compose gates scraper startup on the profile-only migrator", () => {
  assert.match(
    compose,
    /migrator:\s*\n[\s\S]*profiles: \[[^\]]*"migrate", "scrape"/,
  );
  assert.match(compose, /entrypoint: \["node", "db\/src\/migrate-only\.js"\]/);
  assert.match(
    compose,
    /migrator:\s*\n[\s\S]*condition: service_completed_successfully/,
  );
  assert.match(
    compose,
    /MIGRATIONS_ON_STARTUP: \$\{MIGRATIONS_ON_STARTUP:-0\}/,
  );
});

test("database has enough transactional locks for schema replacement restores", () => {
  assert.match(compose, /max_locks_per_transaction=512/);
});

test("backup reads private application state from read-only volume mounts", () => {
  const backup = compose.slice(compose.indexOf("  db-backup:"));
  assert.match(backup, /cap_drop: \[ALL\]/);
  assert.match(backup, /cap_add: \[DAC_READ_SEARCH\]/);
  assert.match(backup, /superset_home:\/superset-home:ro/);
  assert.match(backup, /read_only: true/);
});

test("database checkpoint settings avoid long scrape stalls", () => {
  assert.match(compose, /max_wal_size=4GB/);
  assert.match(compose, /checkpoint_timeout=15min/);
});

test("Compose targets PostgreSQL 18", () => {
  assert.match(compose, /baosystems\/postgis:18-3\.6@sha256:/);
  assert.match(
    compose,
    /name: \$\{POSTGRES_VOLUME_NAME:-olx-price-ext_pgdata_pg18\}/,
  );
});

test("Compose provisions only the lean schema and dashboard assets", () => {
  assert.match(compose, /DB_INIT_DIR:-\.\/db\/init-lean/);
  assert.match(compose, /dockerfile: superset\/Dockerfile/);
  assert.match(compose, /target: 8088\s+published: "3000"/);
});

test("access jobs mount their local Python import dependencies", () => {
  // These jobs bind current helpers over the image's copies. Follow their
  // imports so a previously built image cannot hide a missing helper mount.
  const accessService = compose
    .split("  superset-access:")[1]
    .split("\n  #")[0];
  const pending = ["access", "validate_access"];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    assert.ok(
      accessService.includes(`./superset/${name}.py:/app/${name}.py:ro`),
      `superset-access must mount ${name}.py from the current checkout`,
    );
    const source = fs.readFileSync(
      path.join(ROOT, "superset", `${name}.py`),
      "utf8",
    );
    for (const [, dependency] of source.matchAll(/^from (\w+) import /gm)) {
      if (fs.existsSync(path.join(ROOT, "superset", `${dependency}.py`))) {
        pending.push(dependency);
      }
    }
  }
});

test("deployment runs migration job before publishing the stack", () => {
  const ownershipAt = deploy.indexOf("zz-database-roles.sh");
  const migrateAt = deploy.indexOf("docker compose --profile migrate run");
  const upAt = deploy.indexOf("docker compose up -d --build");
  assert.ok(
    ownershipAt >= 0 && ownershipAt < migrateAt,
    "deploy script must repair existing role ownership before migrations",
  );
  assert.ok(migrateAt >= 0, "deploy script must run the migrator job");
  assert.ok(upAt > migrateAt, "stack startup must follow migration completion");
});

test("home sync repairs stopped dependencies with stale network endpoints", () => {
  const sync = fs.readFileSync(
    path.join(ROOT, "scripts", "sync-to-instance.ps1"),
    "utf8",
  );
  assert.match(sync, /function Remove-StaleComposeContainer/);
  assert.match(sync, /NetworkSettings\.Networks/);
  assert.match(sync, /docker rm -f \$id/);
  assert.match(sync, /Remove-StaleComposeContainer 'db'/);
  assert.match(sync, /Remove-StaleComposeContainer 'migrator'/);
  assert.match(sync, /build scraper migrator/);
  assert.ok(
    sync.indexOf("Remove-StaleComposeContainer 'migrator'") <
      sync.indexOf("Log 'building scraper and migrator images"),
    "stale dependency repair must run before the scrape pipeline",
  );
});

test("one-shot scraper closes healthcheck sockets before waiting for server close", () => {
  const index = fs.readFileSync(
    path.join(ROOT, "collector", "src", "index.js"),
    "utf8",
  );
  const once = index.slice(index.lastIndexOf("if (config.runOnce)"));
  const destroySocketsAt = once.indexOf(
    "healthServer.closeAllConnections?.();",
  );
  const waitForCloseAt = once.indexOf("healthServer.close(resolve)");
  assert.ok(
    destroySocketsAt >= 0,
    "one-shot shutdown must destroy open sockets",
  );
  assert.ok(waitForCloseAt >= 0, "one-shot shutdown must await server close");
  assert.ok(
    destroySocketsAt < waitForCloseAt,
    "open healthcheck sockets must be destroyed before close() is awaited",
  );
});

test("production viewer settings fail closed before deployment", () => {
  assert.match(deploy, /validate_origin SUPERSET/);
  assert.match(deploy, /127\.0\.0\.1/);
  assert.match(deploy, /https:\/\/\*\//);
  assert.match(deploy, /COOKIE_SECURE/);
});

test("remote sync refreshes Superset after role repair before reporting success", () => {
  const restore = fs.readFileSync(
    path.join(ROOT, "db", "remote-restore.sh"),
    "utf8",
  );
  const grantsAt = restore.lastIndexOf(
    "docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh",
  );
  const refreshAt = restore.indexOf(
    "if ! docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 superset; then",
  );
  const successAt = restore.indexOf('echo "RESTORE_OK');
  assert.ok(grantsAt >= 0 && refreshAt > grantsAt);
  assert.ok(successAt > refreshAt);
  assert.match(
    restore.slice(refreshAt, successAt),
    /RESTORE_ERROR: database restored, but dashboard refresh failed[\s\S]*exit 1/,
  );
  assert.ok(
    restore.indexOf("restore_ok=1") > grantsAt,
    "writer recovery must remain active until role repair completes",
  );
});

test("Cloudflare Tunnel is the documented public entry point", () => {
  const operations = fs.readFileSync(
    path.join(ROOT, "docs", "OPERATIONS.md"),
    "utf8",
  );
  assert.match(operations, /Cloudflare Tunnel/);
  assert.match(operations, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(operations, /systemctl status cloudflared/);
  assert.match(operations, /no public OCI 80\/443\s+ingress/i);
  assert.equal(
    fs.existsSync(path.join(ROOT, "deploy", "caddy", "Caddyfile.example")),
    false,
  );
});
