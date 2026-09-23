"use strict";

/**
 * Capture the daily partitions that a publication can change before its dirty
 * queue is consumed. A missing daily refresh marker means the next publication
 * is a full rebuild and every registered child is affected.
 */
async function captureOlapAnalyzeTargets(pool, { forceFull = false } = {}) {
  const state = await pool.query(`
    SELECT EXISTS (
             SELECT 1 FROM olap.refresh_state
              WHERE mart = 'daily_listing_facts'
           ) AS has_daily_publication`);
  const full = forceFull || !state.rows[0]?.has_daily_publication;
  const dirty = full
    ? { rows: [] }
    : await pool.query(`
        SELECT DISTINCT date_trunc('month', day)::date AS month
          FROM public.analytics_daily_olap_dirty
         ORDER BY month`);
  const months = dirty.rows.map((row) => row.month);
  const partitions = await pool.query(
    `SELECT child_table
       FROM public.analytics_partition_registry
      WHERE parent_schema = 'olap'
        AND parent_table = 'daily_listing_facts'
        AND ($1::boolean OR date_trunc('month', from_at AT TIME ZONE 'UTC')::date = ANY($2::date[]))
      ORDER BY from_at`,
    [full, months],
  );

  return partitions.rows.map((row) => row.child_table);
}

/** Refresh only the OLAP statistics used by dashboard queries. */
async function analyzePublishedOlap(pool, dailyPartitions) {
  const result = await pool.query(
    "SELECT public.analyze_published_olap($1::text[]) AS relations",
    [dailyPartitions],
  );
  return { relations: Number(result.rows[0]?.relations || 0) + 2 };
}

module.exports = { analyzePublishedOlap, captureOlapAnalyzeTargets };
