"use strict";

// Repeatable disposable-database harness for the analytics investigation.
// Seeding is explicit because it writes 3000 listings and roughly 600k
// twelve-hour state sightings. Run with ANALYTICS_BENCHMARK_SEED=1 only on a
// disposable volume; all rows use the reserved article-id range below.
const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const baseArticleId = Number(
  process.env.ANALYTICS_BENCHMARK_BASE_ARTICLE_ID || 900000000,
);
const listingCount = Number(process.env.ANALYTICS_BENCHMARK_LISTINGS || 3000);
const days = Number(process.env.ANALYTICS_BENCHMARK_DAYS || 50);
if (!Number.isSafeInteger(baseArticleId) || baseArticleId <= 0)
  throw new Error("ANALYTICS_BENCHMARK_BASE_ARTICLE_ID must be positive");
if (!Number.isSafeInteger(listingCount) || listingCount < 1)
  throw new Error("ANALYTICS_BENCHMARK_LISTINGS must be positive");
if (!Number.isSafeInteger(days) || days < 1)
  throw new Error("ANALYTICS_BENCHMARK_DAYS must be positive");

const firstId = baseArticleId;
const lastId = baseArticleId + listingCount - 1;

async function seed(pool) {
  await pool.query("BEGIN");
  try {
    await pool.query(
      "SELECT set_config('app.history_maintenance', 'retention', true)",
    );
    for (const table of [
      "public.listing_daily",
      "public.price_history",
      "public.search_results",
    ]) {
      await pool.query(
        `DELETE FROM ${table} WHERE article_id BETWEEN $1 AND $2`,
        [firstId, lastId],
      );
    }
    await pool.query(
      `DELETE FROM public.listing_state_history
        WHERE article_id BETWEEN $1 AND $2`,
      [firstId, lastId],
    );
    await pool.query(
      `DELETE FROM public.listing_price_events
        WHERE article_id BETWEEN $1 AND $2`,
      [firstId, lastId],
    );
    await pool.query(
      `DELETE FROM public.listings
        WHERE article_id BETWEEN $1 AND $2`,
      [firstId, lastId],
    );
    await pool.query(
      `INSERT INTO public.listings
         (article_id, url, title, sqm, rooms, is_rent, first_seen, last_seen,
          latitude, longitude)
       SELECT id, 'https://benchmark.invalid/' || id, 'analytics benchmark',
              50 + (id % 80), '2', false, now() - interval '50 days', now(),
              CASE WHEN id % 10 = 0 THEN 45.3 ELSE 44.78 + ((id % 100) * 0.00001) END,
              CASE WHEN id % 10 = 0 THEN 18.7 ELSE 17.19 + ((id % 100) * 0.00001) END
         FROM generate_series($1::bigint, $2::bigint) id
       ON CONFLICT (article_id) DO NOTHING`,
      [firstId, lastId],
    );
    await pool.query(
      `INSERT INTO public.listing_state_versions
         (state_hash, category, category_membership, is_rent, sqm, rooms,
          filter_attributes)
       SELECT public.listing_state_version_hash(
                'apartments', ARRAY['apartments'], false, l.sqm, l.rooms,
                jsonb_build_object('latitude', l.latitude::text,
                                   'longitude', l.longitude::text), false, false),
              'apartments', ARRAY['apartments'], false, l.sqm, l.rooms,
              jsonb_build_object('latitude', l.latitude::text,
                                 'longitude', l.longitude::text)
         FROM public.listings l
        WHERE l.article_id BETWEEN $1 AND $2
       ON CONFLICT (state_hash) DO NOTHING`,
      [firstId, lastId],
    );
    await pool.query(
      `INSERT INTO public.listing_state_history
         (article_id, effective_at, source, event_type, state_version_id,
          last_seen_at)
       SELECT l.article_id,
              now() - make_interval(days => d, hours => h),
              'search', 'search_sighting', v.state_version_id,
              now() - make_interval(days => d, hours => h)
         FROM public.listings l
         JOIN public.listing_state_versions v
           ON v.state_hash = public.listing_state_version_hash(
                'apartments', ARRAY['apartments'], false, l.sqm, l.rooms,
                jsonb_build_object('latitude', l.latitude::text,
                                   'longitude', l.longitude::text), false, false)
         CROSS JOIN generate_series(0, $3::int - 1) d
         CROSS JOIN generate_series(0, 1) h
        WHERE l.article_id BETWEEN $1 AND $2
       `,
      [firstId, lastId, days],
    );
    await pool.query(
      `INSERT INTO public.listing_price_events
         (article_id, effective_at, source, price, price_state)
       SELECT l.article_id,
              now() - make_interval(days => d),
              'benchmark', 100000 + (l.article_id % 10000), 'valid'
         FROM public.listings l
         CROSS JOIN generate_series(0, $3::int - 1) d
        WHERE l.article_id BETWEEN $1 AND $2
       `,
      [firstId, lastId, days],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function timed(pool, label, sql, params = []) {
  const started = process.hrtime.bigint();
  const result = await pool.query(sql, params);
  return {
    label,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    rows: result.rows,
  };
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (process.env.ANALYTICS_BENCHMARK_SEED === "1") {
      await seed(pool);
      console.error(
        `[analytics-benchmark] seeded ${listingCount} listings (${firstId}-${lastId})`,
      );
    }

    const lookup = await timed(
      pool,
      "state_lookup",
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT s.* FROM public.listing_state_history s
        WHERE s.article_id = $1 AND s.effective_at < now()
        ORDER BY s.effective_at DESC, s.id DESC LIMIT 1`,
      [firstId],
    );
    const rebuild = await timed(
      pool,
      "one_past_day_rebuild",
      `SELECT * FROM public.rebuild_listing_daily(
        ((now() AT TIME ZONE 'Europe/Sarajevo')::date - 1),
        ((now() AT TIME ZONE 'Europe/Sarajevo')::date - 1))`,
    );
    await pool.query(
      `UPDATE public.listings SET last_seen = now()
        WHERE article_id BETWEEN $1 AND $2`,
      [firstId, lastId],
    );
    const refresh = await timed(
      pool,
      "refresh_dashboard_olap_false_after_touch",
      "SELECT * FROM reporting.refresh_dashboard_olap(false)",
    );
    const geography = await timed(
      pool,
      "geography_200_inside_outside",
      `SELECT count(*)::int AS calls,
              count(*) FILTER (WHERE public.neighborhood_of(lat, lon) IS NOT NULL)::int AS mapped
         FROM (
           SELECT 44.78 + (g * 0.00001) AS lat, 17.19 + (g * 0.00001) AS lon
             FROM generate_series(1, 100) g
           UNION ALL
           SELECT 45.3 + (g * 0.00001), 18.7 + (g * 0.00001)
             FROM generate_series(1, 100) g
         ) points(lat, lon)`,
    );
    console.log(
      JSON.stringify({ lookup, rebuild, refresh, geography }, null, 2),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
