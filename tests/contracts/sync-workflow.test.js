"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");

const powershellAvailable =
  spawnSync("pwsh", ["--version"], {
    encoding: "utf8",
  }).status === 0;

function verify(scenario) {
  return new Promise((resolve) => {
    execFile(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.join(__dirname, "verify-sync-workflow.ps1"),
        "-Scenario",
        scenario,
      ],
      { encoding: "utf8", timeout: 30000 },
      (error, stdout, stderr) =>
        resolve({
          status: error ? (error.code ?? 1) : 0,
          error,
          stdout,
          stderr,
        }),
    );
  });
}

// Each scenario runs in its own disposable checkout, so they run concurrently.
describe("home sync workflow", { concurrency: true }, () => {
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
    it(
      scenario,
      {
        skip:
          !powershellAvailable && !process.env.CI
            ? "PowerShell 7 is unavailable"
            : false,
      },
      async () => {
        assert.ok(
          powershellAvailable,
          "PowerShell 7 is required for sync tests in CI",
        );
        const result = await verify(scenario);
        assert.equal(
          result.status,
          0,
          result.error?.message || `${result.stdout}\n${result.stderr}`,
        );
      },
    );
  }
});
