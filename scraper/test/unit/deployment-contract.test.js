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
const caddy = fs.readFileSync(
  path.join(ROOT, "deploy", "caddy", "Caddyfile.example"),
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

test("production Grafana settings fail closed before deployment", () => {
  assert.match(deploy, /GRAFANA_BIND/);
  assert.match(deploy, /127\.0\.0\.1/);
  assert.match(deploy, /GRAFANA_DOMAIN/);
  assert.match(deploy, /GRAFANA_ROOT_URL/);
  assert.match(deploy, /https:\/\/\*\//);
  assert.match(deploy, /GRAFANA_ENFORCE_DOMAIN/);
  assert.match(deploy, /GRAFANA_COOKIE_SECURE/);
});

test("Caddy example proxies only the private Grafana listener", () => {
  assert.match(caddy, /grafana\.example\.com\s*\{/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.doesNotMatch(caddy, /tls_insecure_skip_verify/);
});
