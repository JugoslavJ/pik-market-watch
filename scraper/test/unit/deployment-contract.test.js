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

test("deployment runs migration job before publishing the stack", () => {
  const migrateAt = deploy.indexOf("docker compose --profile migrate run");
  const upAt = deploy.indexOf("docker compose up -d --build");
  assert.ok(migrateAt >= 0, "deploy script must run the migrator job");
  assert.ok(upAt > migrateAt, "stack startup must follow migration completion");
});
