"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const shell =
  process.platform === "win32" ? "C:/Program Files/Git/usr/bin/sh.exe" : "sh";
const shellAvailable = spawnSync(shell, ["-c", "exit 0"]).status === 0;

// Each scenario owns its directory and lock, so scenarios run concurrently.
function run(command, args, { input, ...options }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ status: null, stdout, stderr, error }),
    );
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function restore({ fail = "" } = {}) {
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
    fs.writeFileSync(path.join(root, ".env"), "");
    fs.writeFileSync(
      path.join(root, "bin/docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> commands
case "$*" in
  *'pg_terminate_backend'*) [ "$MOCK_FAIL" != refresh ] ;;
  *'exec -T db pg_restore -U'*) [ "$MOCK_FAIL" != restore ] ;;
  *'/app/check_sync.py'*) [ "$MOCK_FAIL" != check ] ;;
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
    const result = await run(shell, ["restore.sh"], {
      cwd: root,
      input: Buffer.alloc(30000),
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

test.describe("remote sync", { concurrency: true }, () => {
  test(
    "remote sync checks restored data without changing Superset metadata",
    { skip: !shellAvailable ? "POSIX shell unavailable" : false },
    async () => {
      const result = await restore();
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.match(result.stdout, /RESTORE_OK/);
      assert.match(result.stdout, /RESTORE_STAGE restore-and-grants \d+s/);
      assert.match(result.stdout, /RESTORE_STAGE dashboard-query-check \d+s/);
      const commands = result.commands;
      const repair = commands.indexOf("zz-database-roles.sh");
      const audit = commands.indexOf("awk");
      const reset = commands.indexOf("DROP SCHEMA IF EXISTS lean");
      const refresh = commands.indexOf("pg_terminate_backend");
      const check = commands.indexOf("/app/check_sync.py");
      const finalRepair = commands.lastIndexOf("zz-database-roles.sh");
      assert.ok(repair >= 0 && repair < audit && audit < reset);
      assert.ok(
        finalRepair > reset && refresh > finalRepair && check > refresh,
      );
      assert.ok(!/run --rm --no-deps superset-access\n/.test(commands));
      assert.ok(result.incomingRemoved && result.lockRemoved);
    },
  );

  test(
    "remote sync withholds success on restore, refresh or query failure",
    { skip: !shellAvailable ? "POSIX shell unavailable" : false },
    async () => {
      const failures = ["restore", "refresh", "check"];
      const results = await Promise.all(
        failures.map((fail) => restore({ fail })),
      );
      for (const [index, result] of results.entries()) {
        const fail = failures[index];
        assert.notEqual(result.status, 0, fail);
        assert.doesNotMatch(result.stdout, /RESTORE_OK/);
        assert.match(result.stderr, /RESTORE_ERROR/);
        if (fail !== "check")
          assert.ok(!result.commands.includes("/app/check_sync.py"), fail);
        assert.ok(result.incomingRemoved && result.lockRemoved, fail);
      }
    },
  );
});
