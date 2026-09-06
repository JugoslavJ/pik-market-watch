"use strict";

// Static boundary contracts for shell, Compose, and workflow controls. These
// checks keep security-sensitive defaults covered without needing production
// credentials or a remote deployment target.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("workflow deploy boundary is main-only and pinned", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(workflow, /accept-new|pull_request_target/);
  assert.match(workflow, /OCI_KNOWN_HOSTS must be configured/);
  assert.match(workflow, /OCI_SSH_PRIVATE_KEY must be configured/);
});

test("example secrets and Compose listeners fail closed", () => {
  const example = read(".env.example");
  const compose = read("docker-compose.yml");
  for (const name of [
    "POSTGRES_PASSWORD",
    "POSTGRES_APP_PASSWORD",
    "POSTGRES_READER_PASSWORD",
    "GRAFANA_ADMIN_PASSWORD",
    "GRAFANA_SECRET_KEY",
  ])
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  assert.doesNotMatch(example, /change-me/i);
  assert.match(compose, /host_ip: \$\{GRAFANA_BIND:-127\.0\.0\.1\}/);
  assert.match(compose, /HEALTH_BIND: \$\{HEALTH_BIND:-0\.0\.0\.0\}/);
  assert.match(compose, /backend:\s*\n\s*internal: true/);
});

test("backup publication is verified before atomic rename", () => {
  const backup = read("db/backup.sh");
  assert.match(backup, /umask 077/);
  assert.match(backup, /partial="\$out\.partial"/);
  assert.match(backup, /pg_restore -l "\$partial"/);
  assert.match(backup, /mv -f "\$partial" "\$out"/);
  assert.match(backup, /tar -tzf "\$gpartial"/);
  assert.match(backup, /mv -f "\$gpartial" "\$gtar"/);
});

test("restore input and identifiers are bounded and cleaned up", () => {
  const restore = read("db/remote-restore.sh");
  assert.match(restore, /umask 077/);
  assert.match(restore, /536870912/);
  assert.match(restore, /head -c "\$\(\(MAX_BYTES \+ 1\)\)"/);
  assert.doesNotMatch(restore, /cat > "\$incoming"/);
  assert.match(restore, /validate_identifier POSTGRES_APP_USER/);
  assert.match(restore, /validate_identifier POSTGRES_DB/);
  assert.match(restore, /-d "\$db_name"/);
  assert.match(restore, /rm -f "\$incoming" "\$incoming_partial"/);
  assert.match(restore, /trap on_exit EXIT/);
  assert.match(restore, /LOCK=\/tmp\/olx-restore\.lock/);
});
