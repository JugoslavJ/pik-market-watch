"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const shell =
  process.platform === "win32" ? "C:/Program Files/Git/usr/bin/sh.exe" : "sh";
const shellAvailable = spawnSync(shell, ["-c", "exit 0"]).status === 0;

function restore({ provision = "0", fail = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "olx-remote-sync-test-"));
  try {
    for (const directory of ["scripts/lib", "backups", "bin"])
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, "scripts/lib/superset-stack.sh"),
      path.join(root, "scripts/lib/superset-stack.sh"),
    );
    const source = fs
      .readFileSync(path.join(ROOT, "db/remote-restore.sh"), "utf8")
      .replace("LOCK=/tmp/olx-restore.lock", 'LOCK="$REPO_DIR/fixture-lock"');
    fs.writeFileSync(path.join(root, "restore.sh"), source);
    fs.writeFileSync(
      path.join(root, ".env"),
      `OLX_SYNC_PROVISION_DASHBOARDS=${provision}\n`,
    );
    fs.writeFileSync(
      path.join(root, "bin/docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> commands
case "$*" in
  *'up -d --no-deps --force-recreate'*) [ "$MOCK_FAIL" != refresh ] ;;
  *'exec -T db pg_restore -U'*) [ "$MOCK_FAIL" != restore ] ;;
  *'/app/check_sync.py'*) [ "$MOCK_FAIL" != check ] ;;
  *'run --rm --no-deps superset-seed') [ "$MOCK_FAIL" != seed ] ;;
  *'run --rm --no-deps superset-access') [ "$MOCK_FAIL" != access ] ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: [
        path.join(root, "bin"),
        ...(process.platform === "win32" ? [path.dirname(shell)] : []),
        process.env.PATH,
      ].join(path.delimiter),
      OLX_REPO_DIR: ".",
      OLX_SYNC_MAX_BYTES: "536870912",
      MOCK_FAIL: fail,
    };
    delete env.OLX_SYNC_PROVISION_DASHBOARDS;
    const result = spawnSync(shell, ["restore.sh"], {
      cwd: root,
      input: Buffer.alloc(30000),
      encoding: "utf8",
      timeout: 30000,
      env,
    });
    return {
      ...result,
      commands: fs.existsSync(path.join(root, "commands"))
        ? fs.readFileSync(path.join(root, "commands"), "utf8")
        : "",
      incomingRemoved: !fs.existsSync(
        path.join(root, "backups/olx-sync-incoming.dump"),
      ),
      lockRemoved: !fs.existsSync(path.join(root, "fixture-lock")),
    };
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("olx-remote-sync-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  "remote sync checks restored charts and provisions only when requested",
  { skip: !shellAvailable ? "POSIX shell unavailable" : false },
  () => {
    for (const provision of ["0", "1"]) {
      const result = restore({ provision });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.match(result.stdout, /RESTORE_OK/);
      assert.match(result.stdout, /RESTORE_STAGE restore-and-grants \d+s/);
      assert.match(result.stdout, /RESTORE_STAGE dashboard-query-check \d+s/);
      const commands = result.commands;
      const refresh = commands.indexOf("--force-recreate --wait");
      const check = commands.indexOf("/app/check_sync.py");
      assert.ok(refresh >= 0 && check > refresh);
      assert.equal(
        commands.includes("run --rm --no-deps superset-seed"),
        provision === "1",
      );
      assert.equal(
        commands.includes("run --rm --no-deps superset-access"),
        provision === "1",
      );
      if (provision === "1") {
        assert.ok(
          commands.indexOf("--no-deps superset-seed") <
            commands.indexOf("--no-deps superset-access"),
        );
        assert.ok(commands.indexOf("--no-deps superset-access") < check);
      }
      assert.ok(result.incomingRemoved && result.lockRemoved);
    }
  },
);

test(
  "invalid provisioning configuration fails before database operations",
  { skip: !shellAvailable ? "POSIX shell unavailable" : false },
  () => {
    const result = restore({ provision: "invalid" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OLX_SYNC_PROVISION_DASHBOARDS must be 0 or 1/);
    assert.equal(result.commands, "");
  },
);

test(
  "remote sync withholds success on restore, refresh, provisioning or query failure",
  { skip: !shellAvailable ? "POSIX shell unavailable" : false },
  () => {
    for (const fail of ["restore", "refresh", "seed", "access", "check"]) {
      const result = restore({ provision: "1", fail });
      assert.notEqual(result.status, 0, fail);
      assert.doesNotMatch(result.stdout, /RESTORE_OK/);
      assert.match(result.stderr, /RESTORE_ERROR/);
      if (fail !== "check")
        assert.ok(!result.commands.includes("/app/check_sync.py"), fail);
      assert.ok(result.incomingRemoved && result.lockRemoved, fail);
    }
  },
);
