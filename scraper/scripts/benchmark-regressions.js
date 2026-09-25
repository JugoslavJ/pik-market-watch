"use strict";

// Phase 0 disposable-DB harness.  Run it once per schema with a separate
// DATABASE_URL and combine the results with BENCHMARK_REFERENCE_DATABASE_URL.
// The seed deliberately gives every listing/cycle its own state version so a
// planner cannot hide lookup cost behind a shared Memoize entry.
const { Pool } = require("pg");

const listingCount = Number(process.env.BENCHMARK_LISTINGS || 10000);
const dailyDays = 20;
const historyCycles = 6;
const baseId = Number(process.env.BENCHMARK_BASE_ARTICLE_ID || 700000000);
const referenceUrl = process.env.BENCHMARK_REFERENCE_DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!Number.isSafeInteger(listingCount) || listingCount < 1)
  throw new Error("BENCHMARK_LISTINGS must be a positive integer");

const ids = [baseId, baseId + listingCount - 1];
const timed = async (pool, label, sql, params = []) => {
  const start = process.hrtime.bigint();
  const result = await pool.query(sql, params);
  return {
    label,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
    rowCount: result.rowCount,
  };
};

async function seed(pool) {
  await pool.query("BEGIN");
  try {
    await pool.query(
      "SELECT set_config('app.history_maintenance', 'retention', true)",
    );
    for (const table of [
      "public.listing_daily",
      "public.listing_price_events",
      "public.listing_state_history",
      "olap.daily_listing_facts",
      "public.listings",
    ]) {
      await pool.query(
        `DELETE FROM ${table} WHERE article_id BETWEEN $1 AND $2`,
        ids,
      );
    }
    await pool.query(
      `INSERT INTO public.listings
         (article_id, url, title, sqm, rooms, is_rent, first_seen, last_seen)
       SELECT g, 'https://benchmark.invalid/' || g, 'benchmark ' || g,
              50 + (g % 80), '2', false,
              now() - interval '90 days', now() - interval '1 day'
         FROM generate_series($1::bigint, $2::bigint) g`,
      ids,
    );
    await pool.query(
      `INSERT INTO public.listing_state_versions
         (state_hash, category, category_membership, is_rent, sqm, rooms,
          filter_attributes)
       SELECT public.listing_state_version_hash(
                'apartments', ARRAY['apartments'], false, 50 + (g % 80), '2',
                jsonb_build_object('title', 'state-' || g), false, false),
              'apartments', ARRAY['apartments'], false, 50 + (g % 80), '2',
              jsonb_build_object('title', 'state-' || g)
         FROM generate_series($1::bigint, $2::bigint) g
       ON CONFLICT (state_hash) DO NOTHING`,
      ids,
    );
    await pool.query(
      `INSERT INTO public.listing_state_history
         (article_id, effective_at, source, event_type, state_version_id,
          price, last_seen_at)
       SELECT l.article_id,
              now() - make_interval(days => 60 - cycle * 8),
              'search', 'search_sighting', v.state_version_id,
              100000, now() - make_interval(days => 60 - cycle * 8)
         FROM generate_series(0, $3::int - 1) cycle
         CROSS JOIN public.listings l
         JOIN public.listing_state_versions v
           ON v.filter_attributes->>'title' = 'state-' || l.article_id::text
        WHERE l.article_id BETWEEN $1 AND $2`,
      [...ids, historyCycles],
    );
    await pool.query(
      `INSERT INTO public.listing_daily
         (day, article_id, price, price_state, ppm2, state_version_id,
          location, state_effective_at, price_effective_at, neighborhood)
       SELECT date '2026-09-01' + d, l.article_id, 100000, 'valid',
              2000, v.state_version_id, 'n3', now() - interval '1 day',
              now() - interval '1 day', 'n3'
         FROM generate_series(0, $3::int - 1) d
         CROSS JOIN public.listings l
         JOIN public.listing_state_versions v
           ON v.filter_attributes->>'title' = 'state-' || l.article_id::text
        WHERE l.article_id BETWEEN $1 AND $2`,
      [...ids, dailyDays],
    );
    await pool.query(
      `INSERT INTO olap.daily_listing_facts
         (day, article_id, price, price_state, ppm2, state_effective_at,
          price_effective_at, property_type, room_bucket, currency,
          price_quality_reason, rate_quality_reason, price_eligible,
          rate_eligible, asking_price, asking_rate, asking_price_unit,
          asking_rate_unit, deal, neighborhood)
       SELECT date '2026-09-01' + d, l.article_id, 100000, 'valid', 2000,
              now() - interval '1 day', now() - interval '1 day',
              'apartment', '2', 'BAM', NULL, NULL, true, true, 100000,
              2000, 'KM', 'KM/m²', 'sale', 'n3'
         FROM generate_series(0, $3::int - 1) d
         CROSS JOIN public.listings l
        WHERE l.article_id BETWEEN $1 AND $2`,
      [...ids, dailyDays],
    );
    // 120 events/listing = 1.2M rows; all timestamps are safely in the past.
    await pool.query(
      `INSERT INTO public.listing_price_events
         (article_id, effective_at, observed_at, price, price_state, source)
       SELECT l.article_id, now() - make_interval(days => 200 - e),
              now() - make_interval(days => 200 - e),
              100000 + (e % 7), 'valid', 'search'
         FROM public.listings l
         CROSS JOIN generate_series(0, 119) e
        WHERE l.article_id BETWEEN $1 AND $2`,
      ids,
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function measure(url, label, offset) {
  const pool = new Pool({ connectionString: url });
  try {
    if (process.env.BENCHMARK_SKIP_SEED !== "1") await seed(pool);
    const measurements = [];
    measurements.push(
      await timed(
        pool,
        "listings_update_unchanged_10k",
        `UPDATE public.listings SET last_seen = last_seen
          WHERE article_id BETWEEN $1 AND $2`,
        [ids[0] + offset, ids[1] + offset],
      ),
    );
    measurements.push(
      await timed(
        pool,
        "sighting_insert_10k",
        `INSERT INTO public.listing_state_history
           (article_id, effective_at, source, event_type, state_version_id,
            price, last_seen_at)
         SELECT l.article_id, now() - interval '1 hour', 'search',
                'search_sighting', min(v.state_version_id), 100000,
                now() - interval '1 hour'
           FROM public.listings l
           JOIN public.listing_state_versions v
             ON v.filter_attributes->>'title' = 'state-' || l.article_id::text
          WHERE l.article_id BETWEEN $1 AND $2
          GROUP BY l.article_id`,
        [ids[0] + offset, ids[1] + offset],
      ),
    );
    measurements.push(
      await timed(
        pool,
        "market_daily_filtered_unfiltered",
        `SELECT * FROM public.market_daily_filtered(
          '2026-09-01', '2026-09-20', '{}', NULL, NULL, '{}', '{}', '{}')`,
      ),
    );
    measurements.push(
      await timed(
        pool,
        "market_daily_filtered_deal_neighborhood",
        `SELECT * FROM public.market_daily_filtered(
          '2026-09-01', '2026-09-20', '{}', NULL, NULL, '{}', '{sale}', '{n3}')`,
      ),
    );
    measurements.push(
      await timed(
        pool,
        "latest_price_lookup_10k_1_2m_events",
        `SELECT ids.article_id, latest.effective_at, latest.price
           FROM unnest($1::bigint[]) ids(article_id)
          CROSS JOIN LATERAL (
            SELECT e.effective_at, e.price
              FROM public.listing_price_events e
             WHERE e.article_id = ids.article_id
             ORDER BY e.effective_at DESC, e.id DESC
             LIMIT 1) latest`,
        [Array.from({ length: listingCount }, (_, i) => ids[0] + offset + i)],
      ),
    );
    return { schema: label, measurements };
  } finally {
    await pool.end();
  }
}

async function main() {
  const current = await measure(process.env.DATABASE_URL, "current", 0);
  const reference = referenceUrl
    ? await measure(referenceUrl, "reference", 0)
    : { schema: "reference", skipped: "set BENCHMARK_REFERENCE_DATABASE_URL" };
  console.log(
    JSON.stringify(
      { listingCount, historyCycles, dailyDays, current, reference },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
