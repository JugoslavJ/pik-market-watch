"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const artifacts = path.join(root, "data/superset-validation");
const origin = process.env.SUPERSET_TEST_URL || "http://127.0.0.1:3000";
const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

function loadChromium() {
  return require(require.resolve("playwright", { paths: [artifacts, root] }))
    .chromium;
}

function readPassword({
  env = process.env,
  envFile = path.join(root, ".env"),
} = {}) {
  if (env.SUPERSET_ADMIN_PASSWORD) return env.SUPERSET_ADMIN_PASSWORD;
  let source;
  try {
    source = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const password = source
    ?.match(/^SUPERSET_ADMIN_PASSWORD=(.*)$/m)?.[1]
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  if (!password)
    throw new Error("Configure SUPERSET_ADMIN_PASSWORD for browser validation");
  return password;
}

function browserOptions({
  webgl = true,
  browser = process.env.SUPERSET_TEST_BROWSER,
} = {}) {
  return {
    headless: true,
    executablePath: browser || (fs.existsSync(edge) ? edge : undefined),
    ...(webgl
      ? {
          args: [
            "--enable-webgl",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
          ],
        }
      : {}),
  };
}

module.exports = {
  root,
  artifacts,
  origin,
  loadChromium,
  readPassword,
  browserOptions,
};
