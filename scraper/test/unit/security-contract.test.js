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
    "POSTGRES_MIGRATOR_PASSWORD",
    "POSTGRES_APP_PASSWORD",
    "POSTGRES_REPORTING_PASSWORD",
    "POSTGRES_BACKUP_PASSWORD",
    "SUPERSET_META_PASSWORD",
    "SUPERSET_ADMIN_PASSWORD",
    "SUPERSET_SECRET_KEY",
  ])
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  assert.doesNotMatch(example, /change-me/i);
  assert.match(compose, /host_ip: \$\{SUPERSET_BIND:-127\.0\.0\.1\}/);
  assert.match(compose, /HEALTH_BIND: \$\{HEALTH_BIND:-0\.0\.0\.0\}/);
  assert.match(compose, /backend:\s*\n\s*internal: true/);
});

test("viewer reuses port 3000 behind Cloudflare Tunnel", () => {
  const compose = read("docker-compose.yml");
  const example = read(".env.example");
  const config = read("superset/superset_config.py");
  assert.match(compose, /target: 8088\s+published: "3000"/);
  assert.match(compose, /SUPERSET_ROOT_URL:-http:\/\/localhost:3000\//);
  assert.match(compose, /http:\/\/127\.0\.0\.1:8088\/health/);
  assert.match(config, /SESSION_COOKIE_HTTPONLY = True/);
  assert.match(config, /SESSION_COOKIE_SAMESITE = "Lax"/);
  assert.match(config, /AUTH_USER_REGISTRATION = False/);
  assert.doesNotMatch(compose, /GF_SERVER_|image: grafana\//);
  for (const name of [
    "SUPERSET_DOMAIN",
    "SUPERSET_ROOT_URL",
    "SUPERSET_COOKIE_SECURE",
  ])
    assert.match(example, new RegExp(`^${name}=`, "m"));
});

test("backup publication is verified before atomic rename", () => {
  const backup = read("db/backup.sh");
  assert.match(backup, /umask 077/);
  assert.match(backup, /partial=\$\(mktemp "\$out\.partial\.XXXXXX"\)/);
  assert.match(backup, /pg_restore -l "\$partial"/);
  assert.match(backup, /mv -f "\$partial" "\$out"/);
  assert.match(backup, /tar -tzf "\$partial"/);
  assert.match(backup, /archive_volume superset-home "\$SUPERSET_HOME"/);
});

test("database roles separate reporting and backup access", () => {
  const roles = read("db/init-lean/zz-database-roles.sh");
  assert.match(roles, /GRANT pg_read_all_data TO %I.*backup_user/);
  assert.match(roles, /REVOKE pg_read_all_data FROM %I.*reporting_user/);
  assert.match(roles, /GRANT SELECT ON %I\.%I TO %I/);
  assert.match(roles, /n\.nspname = 'lean'/);
  assert.doesNotMatch(roles, /GRANT pg_read_all_data TO %I.*reporting_user/);
});

test("lean database role repair limits Grafana to direct lean reads", () => {
  const roles = read("db/init-lean/zz-database-roles.sh");
  assert.match(roles, /n\.nspname IN \('public', 'lean'\)/);
  assert.match(roles, /GRANT SELECT ON %I\.%I TO %I/);
  assert.match(
    roles,
    /'listing_lifecycle_events','scrape_runs','scrape_run_pages'/,
  );
  assert.doesNotMatch(
    roles.match(
      /n\.nspname = 'lean'[\s\S]*?AND c\.relkind IN \('r','p','v','m'\) \\gexec/,
    )?.[0] || "",
    /raw_api_responses/,
  );
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
  assert.match(restore, /DROP SCHEMA IF EXISTS lean CASCADE/);
  assert.match(restore, /CREATE SCHEMA lean AUTHORIZATION/);
  assert.match(restore, /TABLE DATA lean listings/);
  assert.match(restore, /reset_schemas && docker compose exec/);
  assert.doesNotMatch(restore, /pg_restore -U[^\n]*--clean/);
  assert.match(restore, /SCHEMA - tiger/);
  assert.match(restore, /SCHEMA - topology/);
  assert.match(
    restore,
    /grep -vE ' SCHEMA - \(lean\|public\|tiger\|topology\) '/,
  );
  assert.match(restore, /grep -vE ' \(COMMENT\|ACL\) - SCHEMA '/);
  assert.match(restore, /grep -ve ' ACL '/);
  assert.match(restore, /CREATE EXTENSION IF NOT EXISTS pg_stat_statements/);
  assert.match(restore, /--no-owner --no-acl/);
});

test("remote restore repairs roles before ownership and schema reset", () => {
  const restore = read("db/remote-restore.sh");
  const roleRepair = restore.indexOf("zz-database-roles.sh");
  const ownershipAudit = restore.indexOf("Ownership audit");
  const schemaReset = restore.indexOf("reset_schemas() {");

  assert.ok(roleRepair >= 0, "restore must invoke the canonical role repair");
  assert.ok(ownershipAudit >= 0, "restore must retain the ownership audit");
  assert.ok(schemaReset >= 0, "restore must retain the schema reset");
  assert.ok(roleRepair < ownershipAudit);
  assert.ok(roleRepair < schemaReset);
});
