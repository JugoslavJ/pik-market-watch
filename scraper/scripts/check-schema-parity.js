"use strict";

// Schema contract check. Callers provide two database URLs to compare.
// pg_dump is used instead of information_schema so routines, views, indexes,
// and constraints are included in the comparison.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fresh = process.env.SCHEMA_PARITY_FRESH_DATABASE_URL;
const forward = process.env.SCHEMA_PARITY_FORWARD_DATABASE_URL;
if (!fresh || !forward) {
  throw new Error(
    "SCHEMA_PARITY_FRESH_DATABASE_URL and SCHEMA_PARITY_FORWARD_DATABASE_URL are required",
  );
}

function dump(url, file) {
  execFileSync(
    process.env.PG_DUMP || "pg_dump",
    ["--schema-only", "--no-owner", "--no-privileges", "--dbname", url],
    { encoding: "utf8", stdio: ["ignore", fs.openSync(file, "w"), "inherit"] },
  );
}

function normalize(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\\restrict.*$/gm, "")
    .replace(/^\\unrestrict.*$/gm, "")
    .replace(/^--.*$/gm, "")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pik-schema-parity-"));
const freshFile = path.join(directory, "fresh.sql");
const forwardFile = path.join(directory, "forward.sql");
try {
  dump(fresh, freshFile);
  dump(forward, forwardFile);
  const left = normalize(freshFile);
  const right = normalize(forwardFile);
  if (left !== right) {
    console.error(
      "schema parity failed: the two canonical schema installations differ",
    );
    process.exitCode = 1;
  } else {
    console.log("schema parity passed");
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
