-- Separate dashboard reads from OLTP event reconstruction.
-- The source view remains the canonical transformation from scraper tables;
-- Grafana's stable view name now reads only the physical OLAP snapshot.

DO $$
BEGIN
  IF to_regclass('reporting.current_listing_scores_source') IS NULL THEN
    ALTER VIEW reporting.current_listing_scores
      RENAME TO current_listing_scores_source;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS reporting.current_listing_scores_olap AS
SELECT * FROM reporting.current_listing_scores_source WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS current_listing_scores_olap_article_idx
  ON reporting.current_listing_scores_olap (article_id);

CREATE INDEX IF NOT EXISTS current_listing_scores_olap_market_idx
  ON reporting.current_listing_scores_olap
    (deal, property_type, neighborhood, room_bucket);
CREATE INDEX IF NOT EXISTS current_listing_scores_olap_score_idx
  ON reporting.current_listing_scores_olap (score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS current_listing_scores_olap_first_seen_idx
  ON reporting.current_listing_scores_olap (first_seen DESC);
CREATE INDEX IF NOT EXISTS current_listing_scores_olap_reduction_idx
  ON reporting.current_listing_scores_olap (latest_reduction_at DESC)
  WHERE latest_reduction_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS reporting.current_market_refresh_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  refreshed_at timestamptz,
  row_count integer NOT NULL DEFAULT 0,
  refresh_duration_ms integer,
  source_max_last_seen timestamptz
);

INSERT INTO reporting.current_market_refresh_state (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION reporting.refresh_current_market()
RETURNS TABLE (rows_written integer, refreshed_at timestamptz)
LANGUAGE plpgsql VOLATILE
SET jit = off
AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows integer;
  v_refreshed_at timestamptz := now();
  v_source_max_last_seen timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('pik-market-watch current market OLAP refresh', 0)
  );

  -- One transaction exposes either the previous complete generation or the
  -- next complete generation to readers, never a partially filled snapshot.
  TRUNCATE reporting.current_listing_scores_olap;
  INSERT INTO reporting.current_listing_scores_olap
  SELECT * FROM reporting.current_listing_scores_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT max(last_seen) INTO v_source_max_last_seen
    FROM reporting.current_listing_scores_olap;

  UPDATE reporting.current_market_refresh_state
     SET refreshed_at = v_refreshed_at,
         row_count = v_rows,
         refresh_duration_ms = greatest(0, round(extract(
           epoch FROM (clock_timestamp() - v_started)) * 1000)::integer),
         source_max_last_seen = v_source_max_last_seen
   WHERE singleton;

  RETURN QUERY SELECT v_rows, v_refreshed_at;
END
$$;

CREATE OR REPLACE VIEW reporting.current_listing_scores AS
SELECT * FROM reporting.current_listing_scores_olap;

-- The drill-down function is part of the Grafana contract too. Rebind it to
-- the snapshot so selecting a subject never reaches back into OLTP history.
DROP FUNCTION reporting.listing_comparables(bigint);
CREATE FUNCTION reporting.listing_comparables(p_article_id bigint)
RETURNS SETOF reporting.current_listing_scores_olap
LANGUAGE sql STABLE
AS $$
  SELECT c.*
    FROM reporting.current_listing_scores_olap t
    JOIN reporting.current_listing_scores_olap c
      ON c.article_id <> t.article_id
     AND c.neighborhood = t.neighborhood
     AND c.property_type = t.property_type
     AND c.is_rent = t.is_rent
     AND c.room_bucket = t.room_bucket
     AND c.sqm BETWEEN t.sqm * 0.8 AND t.sqm * 1.2
     AND (NOT t.is_rent OR c.furnished = t.furnished)
   WHERE t.article_id = p_article_id
     AND t.score_input_reason IS NULL
     AND c.score_input_reason IS NULL
   ORDER BY c.article_id
$$;

COMMENT ON TABLE reporting.current_listing_scores_olap IS
  'OLAP snapshot for private Grafana dashboards; rebuilt from OLTP listing and evidence tables.';
COMMENT ON VIEW reporting.current_listing_scores_source IS
  'Canonical OLTP-to-OLAP transformation; refresh_current_market is its production consumer.';
COMMENT ON VIEW reporting.current_listing_scores IS
  'Stable Grafana contract backed only by the current market OLAP snapshot.';
COMMENT ON FUNCTION reporting.listing_comparables(bigint) IS
  'Exact subject cohort read only from the current market OLAP snapshot.';

SELECT * FROM reporting.refresh_current_market();
