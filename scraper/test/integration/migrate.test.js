"use strict";
// Integration tests for the startup migration runner:
//   A. fresh database — applies everything, second pass is a clean no-op
//   B. pre-squash volume — schema_migrations records retired filenames while
//      the current migration set is a clean no-op
//   C. unsupported legacy databases fail without mutating their data
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const applyMigrations = require("../../src/migrate");
const { needsDb } = require("../helpers/db.js");

const FULL_DIR = path.resolve(__dirname, "..", "..", "..", "db", "init");
const log = () => {}; // keep test output tidy

async function fnCount(pool) {
  return Number(
    (
      await pool.query(
        "SELECT count(*) AS n FROM pg_proc WHERE proname IN ('listings_filtered','room_bucket')",
      )
    ).rows[0].n,
  );
}
async function recorded(pool) {
  return (
    await pool.query("SELECT filename FROM schema_migrations ORDER BY filename")
  ).rows.map((row) => row.filename);
}

const currentMigrations = fs
  .readdirSync(FULL_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();

needsDb(
  "baseline: Docker-style initialization can be adopted by the runner",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_bootstrap"),
    });
    try {
      for (const file of currentMigrations) {
        await pool.query(fs.readFileSync(path.join(FULL_DIR, file), "utf8"));
      }
      await applyMigrations(pool, FULL_DIR, log);
      assert.deepEqual(await recorded(pool), currentMigrations);
    } finally {
      await pool.end();
    }
  },
);

needsDb(
  "baseline: current volume adopts bulk triggers without historical backfills",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_current"),
    });
    try {
      await applyMigrations(pool, FULL_DIR, log);
      // Simulate the immediately preceding schema, before the bulk optimization.
      await pool.query(`
      ALTER TABLE listing_daily DROP COLUMN resolved_state_version CASCADE;
      CREATE TRIGGER listing_daily_resolve_sparse_state BEFORE INSERT ON listing_daily
        FOR EACH ROW EXECUTE FUNCTION resolve_listing_daily_sparse_state();
      CREATE TRIGGER listing_daily_normalize_flags BEFORE INSERT ON listing_daily
        FOR EACH ROW EXECUTE FUNCTION normalize_listing_daily_flags();
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations (filename) VALUES ('20-scrape-page-manifest.sql');
      INSERT INTO listings (article_id, url, title, latitude, longitude)
        VALUES (1, 'test', 'preserved', 44.77, 17.19);
      INSERT INTO scrape_runs (status, finished_at, is_complete)
        VALUES ('ok', now(), false);
    `);
      await applyMigrations(pool, FULL_DIR, log);
      assert.deepEqual(
        (await pool.query("SELECT title, location FROM listings")).rows,
        [{ title: "preserved", location: null }],
      );
      assert.equal(
        (await pool.query("SELECT is_complete FROM scrape_runs")).rows[0]
          .is_complete,
        false,
      );
      const triggers = await pool.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'listing_daily'::regclass AND NOT tgisinternal ORDER BY tgname`);
      assert.deepEqual(
        triggers.rows.map((row) => row.tgname),
        [
          "listing_daily_10_resolve_sparse_state",
          "listing_daily_20_normalize_flags_insert",
          "listing_daily_normalize_flags_update",
        ],
      );
      await applyMigrations(pool, FULL_DIR, () =>
        assert.fail("second pass must be a no-op"),
      );
    } finally {
      await pool.end();
    }
  },
);

// Drop & recreate a dedicated database so cases stay independent of the
// shared suite DB (which other files bootstrap via ensureSchema).
async function recreateDb(name) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return process.env.TEST_DATABASE_URL.replace(/\/[^/]+$/, "/" + name);
}

needsDb(
  "migrations: fresh database applies all files; second pass is a no-op",
  async () => {
    const pool = new Pool({ connectionString: await recreateDb("mig_fresh") });
    await applyMigrations(pool, FULL_DIR, log);
    assert.equal(await fnCount(pool), 2);
    assert.deepEqual(await recorded(pool), currentMigrations);
    const checksums = await pool.query(
      "SELECT filename, checksum FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename",
      [currentMigrations],
    );
    assert.deepEqual(
      checksums.rows,
      currentMigrations.map((filename) => ({
        filename,
        checksum: applyMigrations.migrationChecksum(
          fs.readFileSync(path.join(FULL_DIR, filename), "utf8"),
        ),
      })),
    );

    await applyMigrations(pool, FULL_DIR, log); // second boot
    assert.equal(await fnCount(pool), 2);
    assert.deepEqual(await recorded(pool), currentMigrations);

    // Dashboard panel query runs through the freshly created function:
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM listings_filtered(ARRAY['apartments'], 0, 99999, NULL)",
    );
    assert.equal(typeof r.rows[0].n, "number");
    const numeric = await pool.query(
      "SELECT dashboard_numeric('1.5') AS valid, dashboard_numeric('1e3') AS malformed, dashboard_numeric('') AS blank",
    );
    assert.equal(Number(numeric.rows[0].valid), 1.5);
    assert.equal(numeric.rows[0].malformed, null);
    assert.equal(numeric.rows[0].blank, null);
    await pool.end();
  },
);

needsDb(
  "migrations: baselines legacy ledger rows and rejects edited applied files",
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pik-migrations-"));
    const filename = "001-probe.sql";
    const filePath = path.join(tempDir, filename);
    const original = "CREATE TABLE migration_integrity_probe (id integer);\n";
    fs.writeFileSync(filePath, original);

    const pool = new Pool({
      connectionString: await recreateDb("mig_integrity"),
    });
    try {
      await applyMigrations(pool, tempDir, log);
      const expected = applyMigrations.migrationChecksum(original);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT checksum FROM schema_migrations WHERE filename = $1",
            [filename],
          )
        ).rows,
        [{ checksum: expected }],
      );

      // Simulate a pre-checksum ledger row. It is baselined once and remains
      // protected against edits on subsequent boots.
      await pool.query(
        "UPDATE schema_migrations SET checksum = NULL WHERE filename = $1",
        [filename],
      );
      await applyMigrations(pool, tempDir, log);
      assert.equal(
        (
          await pool.query(
            "SELECT checksum FROM schema_migrations WHERE filename = $1",
            [filename],
          )
        ).rows[0].checksum,
        expected,
      );

      fs.writeFileSync(filePath, `${original}-- edited after deployment\n`);
      await assert.rejects(
        applyMigrations(pool, tempDir, log),
        /migration 001-probe\.sql has changed after being applied/,
      );
    } finally {
      await pool.end();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

needsDb(
  "migrations: pre-squash volume (retired filenames recorded) sees a no-op",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_presquash"),
    });
    await applyMigrations(pool, FULL_DIR, log);

    // Mimic a volume migrated by the retired 01…12 chain: same live schema,
    // but schema_migrations records the old filenames alongside the two that
    // still exist on disk.
    const retiredNames = [
      "02-add-geolocation.sql",
      "03-listing-filters.sql",
      "04-close-listings.sql",
      "05-listing-details.sql",
      "06-market-views.sql",
      "07-api-extras.sql",
      "08-enrichment-fairness.sql",
      "09-search-results-article-idx.sql",
      "10-listing-dates.sql",
      "12-neighborhood-filter.sql",
    ];
    for (const name of retiredNames) {
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [
        name,
      ]);
    }

    // Boot against the squashed directory: nothing to apply, nothing breaks.
    await applyMigrations(pool, FULL_DIR, log);
    assert.equal(await fnCount(pool), 2);
    assert.deepEqual(
      await recorded(pool),
      [...currentMigrations, ...retiredNames].sort(),
    );

    const r = await pool.query(
      "SELECT count(*)::int AS n FROM listings_filtered(ARRAY['apartments'], 0, 99999, NULL)",
    );
    assert.equal(typeof r.rows[0].n, "number");
    await pool.end();
  },
);

needsDb(
  "migrations: unsupported legacy volume fails atomically with upgrade guidance",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_ancient"),
    });

    // Old world: tables shaped exactly like the ORIGINAL 01-schema.sql (all
    // sibling tables complete from day one; only listings grew since), no
    // tracker, none of the later columns or helper objects.
    await pool.query(`CREATE TABLE listings (
      article_id BIGINT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL,
      sqm NUMERIC(8,2), rooms TEXT, price NUMERIC(12,2), price_text TEXT,
      ppm2 INTEGER, is_rent BOOLEAN NOT NULL DEFAULT FALSE,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen  TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE price_history (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      article_id BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
      scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      price NUMERIC(12,2), ppm2 INTEGER)`);
    await pool.query(`CREATE TABLE saved_searches (
      search_key TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      category TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_scraped_at TIMESTAMPTZ, listing_count INTEGER, median_ppm2 INTEGER,
      new_count INTEGER, drop_count INTEGER)`);
    await pool.query(`CREATE TABLE search_results (
      search_key TEXT NOT NULL REFERENCES saved_searches (search_key) ON DELETE CASCADE,
      article_id BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
      PRIMARY KEY (search_key, article_id))`);
    await pool.query(`CREATE TABLE scrape_runs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, search_key TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
      pages INTEGER, cards INTEGER, status TEXT NOT NULL DEFAULT 'running',
      error TEXT)`);
    await pool.query(`INSERT INTO listings (article_id, url, title, sqm, price)
                    VALUES (1, 'https://olx.ba/artikal/1', 'legacy row', 80, 100000)`);
    await pool.query(
      `INSERT INTO saved_searches VALUES ('/k', 'legacy', 'https://olx.ba/k', 'apartments')`,
    );
    await pool.query("INSERT INTO search_results VALUES ('/k', 1)");

    await assert.rejects(
      applyMigrations(pool, FULL_DIR, log),
      /Database predates the current baseline/,
    );
    assert.equal(
      (await pool.query("SELECT title FROM listings WHERE article_id = 1"))
        .rows[0].title,
      "legacy row",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT to_regclass('public.schema_migrations') AS ledger",
        )
      ).rows[0].ledger,
      null,
    );
    await pool.end();
  },
);

needsDb(
  "migrations: detail columns, analytics views and view columns exist",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_details"),
    });
    await applyMigrations(pool, FULL_DIR, log);

    const cols =
      await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'listings' AND column_name IN (
      'closing_category','published_at','renewed_at','seller_type','rooms_detail','bathrooms',
      'floor_num','floors_total','unit_levels','heating','furnished','condition',
      'parking','garage','elevator','year_built','plot_sqm','orientation','views',
      'favorites','characteristics','details_fetched_at')`);
    assert.equal(cols.rows[0].n, 22);

    const views =
      await pool.query(`SELECT count(*)::int AS n FROM information_schema.views
    WHERE table_name IN ('v_active_listings','v_listing_lifecycle','v_market_daily')`);
    assert.equal(views.rows[0].n, 3);

    // v_active_listings must expose the new columns (views snapshot column lists):
    const vc =
      await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'v_active_listings' AND column_name = 'details_fetched_at'`);
    assert.equal(vc.rows[0].n, 1);
    await pool.end();
  },
);

needsDb(
  "migrations: refactor contract tables, indexes and run metadata exist",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_refactor_contract"),
    });
    await applyMigrations(pool, FULL_DIR, log);

    const tables = await pool.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'raw_api_responses', 'listing_state_history', 'listing_price_events',
           'listing_daily', 'analytics_refresh_state', 'scrape_run_pages')`);
    assert.deepEqual(tables.rows.map((row) => row.table_name).sort(), [
      "analytics_refresh_state",
      "listing_daily",
      "listing_price_events",
      "listing_state_history",
      "raw_api_responses",
      "scrape_run_pages",
    ]);

    const runColumns = await pool.query(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'scrape_runs'
         AND column_name IN ('is_complete', 'failure_reason', 'truncation_reason')`);
    assert.deepEqual(runColumns.rows.map((row) => row.column_name).sort(), [
      "failure_reason",
      "is_complete",
      "truncation_reason",
    ]);

    const dailyKey = await pool.query(`
      SELECT count(*)::int AS n
        FROM pg_constraint
       WHERE conrelid = 'listing_daily'::regclass
         AND contype = 'p'`);
    assert.equal(dailyKey.rows[0].n, 1);

    const refresh = await pool.query(
      "SELECT scope FROM analytics_refresh_state WHERE scope = 'listing_daily'",
    );
    assert.deepEqual(refresh.rows, [{ scope: "listing_daily" }]);
    const analytics = await pool.query(`
      SELECT count(*)::int AS n
        FROM information_schema.routines
       WHERE routine_name IN ('market_daily_filtered', 'rebuild_listing_daily')`);
    assert.equal(analytics.rows[0].n, 2);
    await pool.end();
  },
);
