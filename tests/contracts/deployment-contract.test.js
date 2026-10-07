"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

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

test("backup reads private application state from read-only volume mounts", () => {
  const backup = compose.slice(compose.indexOf("  db-backup:"));
  assert.match(backup, /cap_drop: \[ALL\]/);
  assert.match(backup, /cap_add: \[DAC_READ_SEARCH\]/);
  assert.match(backup, /superset_home:\/superset-home:ro/);
  assert.match(backup, /read_only: true/);
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

test("deploy runs the synced script as a file and requires its success line", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const step = workflow.split("- name: Rebuild stack and wait for health")[1];
  assert.ok(step, "deploy step is missing");
  // Piped into `bash -s`, a stdin-reading command swallows the script.
  assert.doesNotMatch(step, /bash -s/);
  assert.doesNotMatch(step, /<\s*scripts\/deploy-stack\.sh/);
  assert.match(step, /bash scripts\/deploy-stack\.sh"[\s\\]*<\s*\/dev\/null/);
  assert.match(
    step,
    /grep -Fq "✓ Stack healthy — deployed \$\{\{ github\.sha \}\} "/,
  );
  const script = fs.readFileSync(
    path.join(ROOT, "scripts/deploy-stack.sh"),
    "utf8",
  );
  assert.match(script, /✓ Stack healthy — deployed \$\{GIT_SHA:-unknown\} /);
  assert.match(script, /exec <\/dev\/null/);
});
