"use strict";

// Static contract checks for the Compose/deploy migration gate. YAML parsing is
// intentionally avoided here because the production stack does not ship a
// YAML runtime dependency; the asserted fragments are the interface we own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
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
  assert.match(compose, /entrypoint: \["node", "src\/migrate-only\.js"\]/);
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

test("database checkpoint settings avoid long scrape stalls", () => {
  assert.match(compose, /max_wal_size=4GB/);
  assert.match(compose, /checkpoint_timeout=15min/);
});

test("scraper publishes OLAP and maintenance does not", () => {
  assert.match(
    compose,
    /scraper:[\s\S]*RUN_ANALYTICS_MAINTENANCE: \$\{RUN_ANALYTICS_MAINTENANCE:-1\}/,
  );
  const maintenance = compose.slice(
    compose.indexOf("  maintenance:"),
    compose.indexOf("  olap-reconcile:"),
  );
  assert.doesNotMatch(maintenance, /RUN_ANALYTICS_MAINTENANCE/);
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

test("home sync pauses a persistent scraper around the snapshot", () => {
  const sync = fs.readFileSync(
    path.join(ROOT, "scripts", "sync-to-instance.ps1"),
    "utf8",
  );
  assert.match(sync, /ps --status running -q scraper/);
  assert.match(sync, /stop scraper/);
  assert.match(sync, /try \{/);
  assert.match(sync, /finally \{/);
  assert.match(sync, /start scraper/);
  assert.ok(
    sync.indexOf("stop scraper") <
      sync.indexOf("run --rm scraper node src/index.js --once"),
    "persistent scraper must be stopped before the one-shot scrape",
  );
  assert.ok(
    sync.indexOf("start scraper") > sync.indexOf("Invoke-SshRestore $dump"),
    "persistent scraper must remain paused through remote restore",
  );
});

test("one-shot scraper closes healthcheck sockets before waiting for server close", () => {
  const index = fs.readFileSync(
    path.join(ROOT, "scraper", "src", "index.js"),
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

test("production Grafana settings fail closed before deployment", () => {
  assert.match(deploy, /GRAFANA_BIND/);
  assert.match(deploy, /127\.0\.0\.1/);
  assert.match(deploy, /GRAFANA_DOMAIN/);
  assert.match(deploy, /GRAFANA_ROOT_URL/);
  assert.match(deploy, /https:\/\/\*\//);
  assert.match(deploy, /GRAFANA_ENFORCE_DOMAIN/);
  assert.match(deploy, /GRAFANA_COOKIE_SECURE/);
});

test("remote sync refreshes Grafana after role repair before reporting success", () => {
  const restore = fs.readFileSync(
    path.join(ROOT, "db", "remote-restore.sh"),
    "utf8",
  );
  const grantsAt = restore.lastIndexOf(
    "docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh",
  );
  const refreshAt = restore.indexOf(
    "if ! docker compose up -d --no-deps --force-recreate --wait --wait-timeout 120 grafana; then",
  );
  const successAt = restore.indexOf('echo "RESTORE_OK');
  assert.ok(grantsAt >= 0 && refreshAt > grantsAt);
  assert.ok(successAt > refreshAt);
  assert.match(
    restore.slice(refreshAt, successAt),
    /RESTORE_ERROR: database restored, but Grafana refresh failed[\s\S]*exit 1/,
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
  assert.equal(
    fs.existsSync(path.join(ROOT, "scripts", "generate-grafana-cert.sh")),
    false,
  );
});
