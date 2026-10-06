"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const powershellAvailable =
  spawnSync("pwsh", ["--version"], {
    encoding: "utf8",
  }).status === 0;

for (const scenario of [
  "success",
  "build-failure",
  "scrape-failure",
  "dump-failure",
  "restore-failure",
  "stale-dependencies",
  "attached-dependencies",
  "running-dependencies",
]) {
  test(
    `home sync workflow: ${scenario}`,
    {
      skip:
        !powershellAvailable && !process.env.CI
          ? "PowerShell 7 is unavailable"
          : false,
    },
    () => {
      assert.ok(
        powershellAvailable,
        "PowerShell 7 is required for sync tests in CI",
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          path.join(__dirname, "verify-sync-workflow.ps1"),
          "-Scenario",
          scenario,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(
        result.status,
        0,
        result.error?.message || `${result.stdout}\n${result.stderr}`,
      );
    },
  );
}
