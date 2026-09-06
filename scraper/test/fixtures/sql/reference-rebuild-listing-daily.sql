-- Pre-bulk implementation retained solely as a regression oracle.
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
