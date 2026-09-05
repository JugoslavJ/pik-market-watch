-- Temporal contracts for price evidence and daily analytics.
--
-- Current search cards are observed at fetch time.  A renewal/bump stamp is
-- useful metadata, but it is not evidence that the asking price changed on
-- that date.  New writers should populate observed_at and, when available,
-- renewed_at while keeping effective_at equal to observed_at.  Historical
-- imports continue to use effective_at as their source-dated assertion.
ALTER TABLE listing_price_events
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS effective_at_basis TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE listing_price_events
  DROP CONSTRAINT IF EXISTS listing_price_events_effective_at_basis_ck;
ALTER TABLE listing_price_events
  ADD CONSTRAINT listing_price_events_effective_at_basis_ck
  CHECK (effective_at_basis IN ('observed', 'source_history', 'legacy'));

-- Existing rows are deliberately marked legacy.  Their dates cannot be
-- repaired safely: a renewal date is not a price-change date.
UPDATE listing_price_events
   SET observed_at = COALESCE(observed_at, ingested_at),
       effective_at_basis = COALESCE(NULLIF(effective_at_basis, ''), 'legacy')
 WHERE observed_at IS NULL OR effective_at_basis IS NULL OR effective_at_basis = '';

CREATE INDEX IF NOT EXISTS listing_price_events_observed_idx
  ON listing_price_events (article_id, observed_at DESC)
  WHERE observed_at IS NOT NULL;

COMMENT ON COLUMN listing_price_events.effective_at IS
  'Source/evidence time used for temporal reconstruction. For current observations this is fetch time.';
COMMENT ON COLUMN listing_price_events.observed_at IS
  'Database fetch/observation time for current evidence; NULL for source-history assertions.';
COMMENT ON COLUMN listing_price_events.renewed_at IS
  'Source renewal/bump timestamp, retained as metadata and never used as price effective time.';
COMMENT ON COLUMN listing_price_events.effective_at_basis IS
  'How effective_at was established: observed, source_history, or legacy/unknown.';

ALTER TABLE analytics_refresh_state
  ADD COLUMN IF NOT EXISTS completed_through_day DATE;

-- Coverage is separate from listing_daily because a valid empty market day
-- has no article rows.  It is the durable distinction between "rebuilt and
-- empty" and "never rebuilt".
CREATE TABLE IF NOT EXISTS analytics_daily_coverage (
  day          DATE PRIMARY KEY,
  rebuilt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  provisional  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS analytics_daily_coverage_rebuilt_idx
  ON analytics_daily_coverage (rebuilt_at DESC);

COMMENT ON COLUMN analytics_refresh_state.completed_through_day IS
  'Latest contiguous Sarajevo day whose daily projection was successfully rebuilt and finalized.';

-- Return a safe maintenance window. The completed watermark makes an empty
-- day distinguishable from a day that was never rebuilt, and therefore lets a
-- scheduler recover a missed interval after an outage.
CREATE OR REPLACE FUNCTION analytics_daily_rebuild_window(p_as_of_day DATE DEFAULT NULL)
RETURNS TABLE (from_day DATE, through_day DATE, reason TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_today DATE := LEAST(
    COALESCE(p_as_of_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date),
    (now() AT TIME ZONE 'Europe/Sarajevo')::date
  );
  v_pending_from DATE;
  v_pending_through DATE;
  v_completed DATE;
  v_first_evidence DATE;
  v_first_daily DATE;
  v_missing_day DATE;
  v_from DATE;
BEGIN
  SELECT pending_from_day, pending_through_day, completed_through_day
    INTO v_pending_from, v_pending_through, v_completed
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily';

  SELECT LEAST(
           (SELECT min((effective_at AT TIME ZONE 'Europe/Sarajevo')::date)
              FROM listing_state_history),
           (SELECT min((effective_at AT TIME ZONE 'Europe/Sarajevo')::date)
              FROM listing_price_events))
    INTO v_first_evidence;
  SELECT min(day) INTO v_first_daily FROM listing_daily;

  IF v_first_evidence IS NOT NULL AND v_today > v_first_evidence THEN
    SELECT min(days.day::date) INTO v_missing_day
      FROM generate_series(v_first_evidence, v_today - 1, interval '1 day') AS days(day)
     WHERE NOT EXISTS (
       SELECT 1 FROM analytics_daily_coverage c
        WHERE c.day = days.day::date
     );
  END IF;

  -- Do not include the first-ever evidence date once a contiguous watermark
  -- exists: doing so would turn every maintenance tick into a full-history
  -- rebuild. A new database (without a watermark) starts at its first
  -- evidence; an existing database resumes from pending/missing days.
  SELECT min(candidate) INTO v_from
    FROM (VALUES
      (v_pending_from),
      (v_missing_day),
      (CASE WHEN v_completed IS NOT NULL THEN v_completed + 1 END),
      (CASE WHEN v_completed IS NULL THEN COALESCE(v_first_evidence, v_first_daily) END),
      (v_today)
    ) AS candidates(candidate)
   WHERE candidate IS NOT NULL;

  -- A future pending bound can be created by a clock-skewed importer; the
  -- rebuild function itself clamps it to today, so the helper does too.
  v_from := LEAST(COALESCE(v_from, v_today), v_today);
  RETURN QUERY
  SELECT v_from,
         v_today,
         CASE
           WHEN v_missing_day IS NOT NULL THEN 'missing_day'
           WHEN v_pending_from IS NOT NULL THEN 'pending_evidence'
           WHEN v_completed IS NULL THEN 'no_completed_watermark'
           WHEN v_completed < v_today - 1 THEN 'missing_or_unfinalized_days'
           ELSE 'provisional_today'
         END;
END
$$;

-- Rebuild with half-open temporal intervals.  An event exactly at Sarajevo
-- midnight belongs to the new day, never to the preceding day.
CREATE OR REPLACE FUNCTION rebuild_listing_daily(
  p_from_day DATE,
  p_through_day DATE
)
RETURNS TABLE (from_day DATE, through_day DATE, rows_written BIGINT)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Europe/Sarajevo')::date;
  v_from DATE := p_from_day;
  v_through DATE := LEAST(p_through_day, v_today);
  v_pending_from DATE;
  v_pending_through DATE;
  v_completed DATE;
  v_horizon DATE;
  v_new_completed DATE;
  v_rows BIGINT;
BEGIN
  IF v_from IS NULL OR v_through IS NULL OR v_from > v_through THEN
    RAISE EXCEPTION 'invalid listing_daily rebuild range: % through %', p_from_day, p_through_day;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch listing_daily rebuild', 0));
  SELECT pending_from_day, pending_through_day, completed_through_day
    INTO v_pending_from, v_pending_through, v_completed
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily'
   FOR UPDATE;

  DELETE FROM listing_daily WHERE day BETWEEN v_from AND v_through;

  INSERT INTO listing_daily (
    day, article_id, price, price_state, ppm2, is_rent, sqm, rooms,
    category, category_memberships, location, filter_attributes,
    state_effective_at, price_effective_at, membership_inferred,
    attributes_inferred, stale_observation, provisional_day
  )
  WITH
  days AS (
    SELECT d::date AS day,
           CASE WHEN d::date = v_today
                -- A scraper timestamp is supplied by the application clock;
                -- permit a small clock skew for the provisional endpoint.
                -- Historical endpoints remain exact half-open midnights.
                THEN clock_timestamp() + interval '5 minutes'
                ELSE analytics_sarajevo_day_start((d::date + 1))
           END AS endpoint
      FROM generate_series(v_from, v_through, interval '1 day') AS s(d)
  ),
  articles AS (
    SELECT article_id FROM listing_state_history
    UNION
    SELECT article_id FROM listing_price_events
  ),
  grid AS (
    SELECT a.article_id, d.day, d.endpoint
      FROM articles a CROSS JOIN days d
  ),
  facts AS (
    SELECT g.*,
           op.effective_at AS observed_effective_at,
           op.id AS observed_id,
           op.category AS observed_category,
           op.category_membership AS observed_membership,
           op.is_rent AS observed_is_rent,
           op.sqm AS observed_sqm,
           op.rooms AS observed_rooms,
           op.filter_attributes AS observed_attributes,
           op.membership_inferred AS observed_membership_inferred,
           op.attributes_inferred AS observed_attributes_inferred,
           fp.effective_at AS future_effective_at,
           fp.id AS future_id,
           fp.category AS future_category,
           fp.category_membership AS future_membership,
           fp.is_rent AS future_is_rent,
           fp.sqm AS future_sqm,
           fp.rooms AS future_rooms,
           fp.filter_attributes AS future_attributes,
           fp.membership_inferred AS future_membership_inferred,
           fp.attributes_inferred AS future_attributes_inferred,
           ep.first_valid_at,
           lp.price AS event_price,
           lp.price_state AS event_price_state,
           lp.effective_at AS event_price_effective_at,
           act.activity_at,
           life.event_type AS latest_lifecycle_event
      FROM grid g
      LEFT JOIN LATERAL (
        SELECT s.* FROM listing_state_history s
         WHERE s.article_id = g.article_id AND s.effective_at < g.endpoint
         ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
      ) op ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.* FROM listing_state_history s
         WHERE s.article_id = g.article_id AND s.effective_at >= g.endpoint
         ORDER BY s.effective_at ASC, s.id ASC LIMIT 1
      ) fp ON TRUE
      LEFT JOIN LATERAL (
        SELECT min(effective_at) AS first_valid_at
          FROM listing_price_events e
         WHERE e.article_id = g.article_id
           AND e.price_state = 'valid'
           AND e.price IS NOT NULL
      ) ep ON TRUE
      LEFT JOIN LATERAL (
         SELECT e.price, e.price_state, e.effective_at
          FROM listing_price_events e
         WHERE e.article_id = g.article_id AND e.effective_at < g.endpoint
         ORDER BY e.effective_at DESC,
                  CASE WHEN e.source IN ('search', 'detail') THEN 0 ELSE 1 END,
                  CASE e.price_state WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                                     WHEN 'unpriced' THEN 2 ELSE 3 END,
                  e.id DESC
         LIMIT 1
      ) lp ON TRUE
      LEFT JOIN LATERAL (
        SELECT max(COALESCE(s.last_seen_at, s.effective_at)) AS activity_at
          FROM listing_state_history s
         WHERE s.article_id = g.article_id
           AND s.effective_at < g.endpoint
           AND s.event_type IN ('search_sighting', 'reopened')
      ) act ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.event_type
          FROM listing_state_history s
         WHERE s.article_id = g.article_id
           AND s.effective_at < g.endpoint
           AND s.event_type IN ('search_sighting', 'closed', 'reopened')
         ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
      ) life ON TRUE
  ),
  resolved AS (
    SELECT f.*,
           (f.observed_id IS NULL) AS state_estimated,
           CASE WHEN f.observed_id IS NOT NULL THEN f.observed_category ELSE f.future_category END AS state_category,
           CASE WHEN f.observed_id IS NOT NULL AND cardinality(f.observed_membership) > 0
                THEN f.observed_membership
                WHEN f.observed_id IS NOT NULL AND f.observed_category IS NOT NULL
                THEN ARRAY[f.observed_category]
                WHEN f.future_membership IS NOT NULL AND cardinality(f.future_membership) > 0
                THEN f.future_membership
                WHEN f.future_category IS NOT NULL THEN ARRAY[f.future_category]
                ELSE '{}'::text[] END AS state_membership,
           COALESCE(f.observed_is_rent, f.future_is_rent) AS state_is_rent,
           COALESCE(f.observed_sqm, f.future_sqm) AS state_sqm,
           COALESCE(f.observed_rooms, f.future_rooms) AS state_rooms,
           COALESCE(f.observed_attributes, f.future_attributes, '{}'::jsonb) AS state_attributes,
           (f.observed_id IS NULL AND f.first_valid_at < f.endpoint)
             OR (f.observed_sqm IS NULL AND f.future_sqm IS NOT NULL)
             OR (f.observed_is_rent IS NULL AND f.future_is_rent IS NOT NULL)
             OR (f.observed_rooms IS NULL AND f.future_rooms IS NOT NULL)
             OR (f.observed_id IS NOT NULL AND cardinality(f.observed_membership) = 0
                 AND cardinality(f.future_membership) > 0) AS attrs_estimated
      FROM facts f
  ),
  eligible AS (
    SELECT r.*,
           CASE
             WHEN r.latest_lifecycle_event = 'closed' THEN FALSE
             WHEN r.activity_at IS NOT NULL
              AND r.activity_at >= r.endpoint - interval '14 days' THEN TRUE
             WHEN r.observed_id IS NULL
              AND r.first_valid_at IS NOT NULL
              AND r.first_valid_at < r.endpoint THEN TRUE
             ELSE FALSE
           END AS is_active
      FROM resolved r
  )
  SELECT e.day, e.article_id,
         CASE WHEN e.event_price_state = 'valid' THEN e.event_price END,
         COALESCE(e.event_price_state, 'unknown'),
         CASE WHEN e.event_price_state = 'valid'
                   AND e.event_price IS NOT NULL
                   AND e.state_is_rent = FALSE
                   AND e.state_sqm BETWEEN 5 AND 500
                   AND e.event_price / NULLIF(e.state_sqm, 0) BETWEEN 1 AND 15000
              THEN round(e.event_price / NULLIF(e.state_sqm, 0))::int END,
         e.state_is_rent, e.state_sqm, e.state_rooms,
         COALESCE(e.state_category, e.state_membership[1]), e.state_membership,
         analytics_state_neighborhood(e.state_attributes), e.state_attributes,
         COALESCE(e.observed_effective_at, e.future_effective_at),
         e.event_price_effective_at,
         COALESCE(e.observed_membership_inferred, false)
           OR e.state_estimated OR COALESCE(e.attrs_estimated, false),
         COALESCE(e.observed_attributes_inferred, false)
           OR e.state_estimated OR COALESCE(e.attrs_estimated, false),
         (e.activity_at IS NOT NULL
           AND (e.activity_at AT TIME ZONE 'Europe/Sarajevo')::date < e.day),
         e.day = v_today
    FROM eligible e
   WHERE e.is_active
     AND (e.observed_id IS NOT NULL OR (e.first_valid_at IS NOT NULL AND e.first_valid_at < e.endpoint));

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO analytics_daily_coverage (day, rebuilt_at, provisional)
  SELECT days.day, now(), days.day = v_today
    FROM generate_series(v_from, v_through, interval '1 day') AS days(day)
  ON CONFLICT (day) DO UPDATE
    SET rebuilt_at = EXCLUDED.rebuilt_at,
        provisional = EXCLUDED.provisional;

  v_horizon := CASE WHEN v_through = v_today THEN v_through - 1 ELSE v_through END;
  v_new_completed := v_completed;
  IF v_horizon IS NOT NULL
     AND ((v_completed IS NULL AND v_from <= v_horizon)
          OR (v_completed IS NOT NULL AND v_from <= v_completed + 1)) THEN
    v_new_completed := GREATEST(COALESCE(v_completed, v_horizon), v_horizon);
  END IF;

  IF v_pending_from IS NULL THEN
    UPDATE analytics_refresh_state
       SET completed_through_day = v_new_completed,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  ELSIF v_from <= v_pending_from AND v_through >= v_pending_through THEN
    UPDATE analytics_refresh_state
       SET pending_from_day = NULL, pending_through_day = NULL,
           completed_through_day = v_new_completed,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  ELSE
    UPDATE analytics_refresh_state
       SET completed_through_day = v_new_completed,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  END IF;

  RETURN QUERY SELECT v_from, v_through, v_rows;
END
$$;
