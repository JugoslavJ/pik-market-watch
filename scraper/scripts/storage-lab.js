"use strict";

// Apply the canonical raw-response structural conversion to one disposable
// benchmark database cloned from the read-only reference snapshot.
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "../..");
const url = process.env.STORAGE_CANDIDATE_DATABASE_URL;
if (!url) throw new Error("STORAGE_CANDIDATE_DATABASE_URL is required");
if (!/^\/storage_candidate(?:_[a-z0-9]+)*$/.test(new URL(url).pathname)) {
  throw new Error("storage-lab only writes to storage_candidate databases");
}

async function main() {
  const threshold = Number(process.env.STORAGE_JSON_PART_THRESHOLD || 1024);
  if (!Number.isInteger(threshold) || threshold < 32 || threshold > 65536) {
    throw new Error(
      "STORAGE_JSON_PART_THRESHOLD must be between 32 and 65536 bytes",
    );
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout='15min'; SET lock_timeout='5s'");
    const action = process.argv[2] || "raw";
    if (action === "refresh-functions") {
      const functions = fs
        .readFileSync(path.join(root, "db/init/03-zz-storage-json.sql"), "utf8")
        .replaceAll(
          "octet_length(part.value::text) >= 1024",
          `octet_length(part.value::text) >= ${threshold}`,
        );
      await client.query("BEGIN");
      await client.query(functions);
      await client.query("COMMIT");
      console.log(JSON.stringify({ action, threshold }));
      return;
    }
    if (action !== "raw") {
      throw new Error("storage-lab action must be raw or refresh-functions");
    }
    await client.query("BEGIN");
    await client.query(
      fs.readFileSync(path.join(root, "db/init/01-storage-json.sql"), "utf8"),
    );
    await client.query(
      fs.readFileSync(
        path.join(root, "db/init/03-z-state-attribute-storage.sql"),
        "utf8",
      ),
    );
    const functions = fs
      .readFileSync(path.join(root, "db/init/03-zz-storage-json.sql"), "utf8")
      .replaceAll(
        "octet_length(part.value::text) >= 1024",
        `octet_length(part.value::text) >= ${threshold}`,
      );
    await client.query(functions);
    await client.query(
      fs.readFileSync(
        path.join(root, "db/init/13-raw-json-storage.sql"),
        "utf8",
      ),
    );
    await client.query("COMMIT");
    const stats = await client.query(`
      SELECT count(*)::bigint AS responses,
             (SELECT count(*) FROM public.storage_json_documents)::bigint AS documents,
             (SELECT count(*) FROM public.storage_json_parts)::bigint AS parts,
             pg_total_relation_size('public.raw_api_response_records')::bigint AS raw_table_bytes
        FROM public.raw_api_response_records`);
    console.log(JSON.stringify({ threshold, ...stats.rows[0] }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
