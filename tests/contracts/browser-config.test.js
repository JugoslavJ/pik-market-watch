"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readPassword, browserOptions } = require("../helpers/browser.cjs");

function envFixture(t, source) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "olx-browser-config-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, ".env");
  fs.writeFileSync(envFile, source);
  return { env: {}, envFile };
}

test("browser credentials prefer the environment without reading a file", () => {
  assert.equal(
    readPassword({
      env: { SUPERSET_ADMIN_PASSWORD: "test-environment-value" },
      envFile: "missing.env",
    }),
    "test-environment-value",
  );
});

test("browser credentials accept quoted values and Windows line endings", (t) => {
  for (const value of ["test value", '"test value"', "'test value'"]) {
    assert.equal(
      readPassword(
        envFixture(
          t,
          `OTHER_SETTING=ignored\r\nSUPERSET_ADMIN_PASSWORD=  ${value}  \r\n`,
        ),
      ),
      "test value",
    );
  }
});

test("missing and empty browser credentials fail without exposing other settings", (t) => {
  const message = /^Configure SUPERSET_ADMIN_PASSWORD for browser validation$/;
  for (const source of [
    "OTHER_SECRET=do-not-print",
    "SUPERSET_ADMIN_PASSWORD=",
    'SUPERSET_ADMIN_PASSWORD=""',
  ]) {
    assert.throws(() => readPassword(envFixture(t, source)), { message });
  }
  assert.throws(() => readPassword({ env: {}, envFile: "missing.env" }), {
    message,
  });
});

test("browser selection honors an explicit executable and supports bundled Chromium", (t) => {
  t.mock.method(fs, "existsSync", () => false);
  assert.equal(
    browserOptions({ browser: "custom-browser" }).executablePath,
    "custom-browser",
  );
  assert.equal(browserOptions({ browser: "" }).executablePath, undefined);
  assert.equal(browserOptions().headless, true);
});

test("browser selection uses installed Edge and keeps WebGL optional", (t) => {
  t.mock.method(fs, "existsSync", () => true);
  assert.equal(
    browserOptions({ browser: "" }).executablePath,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  );
  assert.ok(browserOptions().args.includes("--enable-webgl"));
  assert.equal(browserOptions({ webgl: false }).args, undefined);
});
