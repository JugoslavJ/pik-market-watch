-- Consume the successfully rebuilt prefix of a long dirty range.
--
-- 06-rebuild.sql remains immutable because it is already checksum-protected on
-- deployed volumes.  Keep it as a legacy implementation and wrap it so the
-- data/coverage transaction also advances refresh progress one prefix at a
-- time.  The wrapper is deliberately idempotent: Docker initialization runs
-- all SQL before the migrator records its ledger, so the same file can be
-- adopted by the migrator immediately afterwards.

DO $$
BEGIN
  IF to_regprocedure('rebuild_listing_daily(date,date)') IS NOT NULL
     AND to_regprocedure('rebuild_listing_daily_legacy(date,date)') IS NULL THEN
    ALTER FUNCTION rebuild_listing_daily(date, date)
      RENAME TO rebuild_listing_daily_legacy;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION rebuild_listing_daily(
  p_from_day DATE,
  p_through_day DATE
)
RETURNS TABLE (from_day DATE, through_day DATE, rows_written BIGINT)
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Europe/Sarajevo')::date;
  v_from DATE;
  v_through DATE;
  v_pending_from DATE;
  v_pending_through DATE;
  v_result RECORD;
BEGIN
  v_from := LEAST(p_from_day, v_today);
  v_through := LEAST(p_through_day, v_today);
  IF v_from IS NULL OR v_through IS NULL OR v_from > v_through THEN
    RAISE EXCEPTION 'invalid listing_daily rebuild range: % through %',
      p_from_day, p_through_day;
  END IF;
  -- Match the legacy function's lock order.  Ingestion may insert evidence
  -- while this transaction is running, but its refresh-state update waits for
  -- this row lock and therefore observes the prefix update after commit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('pik-market-watch listing_daily rebuild', 0)
  );
  SELECT pending_from_day, pending_through_day
    INTO v_pending_from, v_pending_through
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily'
   FOR UPDATE;

  SELECT *
    INTO v_result
    FROM rebuild_listing_daily_legacy(v_from, v_through);

  -- Only a chunk beginning at or before the earliest dirty day can acknowledge
  -- that prefix.  A chunk wholly after the dirty interval must not erase work
  -- that was never rebuilt.  The legacy function may already have cleared a
  -- fully covered range; in that case this update is intentionally a no-op.
  IF v_pending_from IS NOT NULL
     AND v_result.from_day <= v_pending_from
     AND v_result.through_day < v_pending_through THEN
    UPDATE analytics_refresh_state
       SET pending_from_day = v_result.through_day + 1,
           updated_at = now()
     WHERE scope = 'listing_daily'
       AND pending_from_day = v_pending_from
       AND pending_through_day = v_pending_through;
  END IF;

  RETURN QUERY SELECT v_result.from_day, v_result.through_day,
                      v_result.rows_written;
END
$$;

COMMENT ON FUNCTION rebuild_listing_daily(date, date) IS
  'Atomically rebuilds a bounded range and consumes only its successfully rebuilt dirty prefix.';
