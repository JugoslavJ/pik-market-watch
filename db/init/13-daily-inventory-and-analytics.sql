-- Package 06: historical daily inventory and reusable analytics.
-- This migration is deliberately additive.  It consumes only the normalized
-- state/price contracts from 12-refactor-schema.sql; current search_results
-- and current listing attributes are not historical sources.

ALTER TABLE listing_daily
  ADD COLUMN IF NOT EXISTS category_memberships TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE listing_daily
  ADD COLUMN IF NOT EXISTS filter_attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE listing_daily
  ADD COLUMN IF NOT EXISTS neighborhood TEXT;

CREATE INDEX IF NOT EXISTS listing_daily_category_memberships_gin_idx
  ON listing_daily USING GIN (category_memberships);
CREATE INDEX IF NOT EXISTS listing_state_history_membership_gin_idx
  ON listing_state_history USING GIN (category_membership);
CREATE INDEX IF NOT EXISTS listing_daily_quality_day_idx
  ON listing_daily (day, price_state, provisional_day, stale_observation);

CREATE OR REPLACE FUNCTION analytics_sarajevo_day_start(p_day DATE)
RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_day::timestamp AT TIME ZONE 'Europe/Sarajevo'
$$;

CREATE OR REPLACE FUNCTION analytics_state_neighborhood(p_attributes JSONB)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    NULLIF(p_attributes->>'location', ''),
    NULLIF(p_attributes->>'neighborhood', ''),
    NULLIF(p_attributes->>'district', ''),
    NULLIF(p_attributes->'searchAttributes'->>'location', ''),
    NULLIF(p_attributes->'searchAttributes'->>'neighborhood', ''),
    NULLIF(p_attributes->'searchAttributes'->>'district', ''),
    CASE
      WHEN COALESCE(p_attributes->>'latitude', p_attributes->'searchAttributes'->>'latitude') IS NULL
       AND COALESCE(p_attributes->>'longitude', p_attributes->'searchAttributes'->>'longitude') IS NULL
      THEN '(no pin)'
      ELSE '(unmapped)'
    END
  )
$$;

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
  v_rows BIGINT;
BEGIN
  IF v_from IS NULL OR v_through IS NULL OR v_from > v_through THEN
    RAISE EXCEPTION 'invalid listing_daily rebuild range: % through %', p_from_day, p_through_day;
  END IF;

  -- One writer at a time makes delete/insert deterministic and prevents a
  -- failed rebuild from publishing a half-reconstructed range.
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch listing_daily rebuild', 0));
  SELECT pending_from_day, pending_through_day
    INTO v_pending_from, v_pending_through
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
                THEN now()
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
         WHERE s.article_id = g.article_id AND s.effective_at <= g.endpoint
         ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
      ) op ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.* FROM listing_state_history s
         WHERE s.article_id = g.article_id AND s.effective_at > g.endpoint
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
         WHERE e.article_id = g.article_id AND e.effective_at <= g.endpoint
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
           AND s.effective_at <= g.endpoint
           AND s.event_type IN ('search_sighting', 'reopened')
      ) act ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.event_type
          FROM listing_state_history s
         WHERE s.article_id = g.article_id
           AND s.effective_at <= g.endpoint
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
           (f.observed_id IS NULL AND f.first_valid_at <= f.endpoint)
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
              AND r.first_valid_at <= r.endpoint THEN TRUE
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
     AND (e.observed_id IS NOT NULL OR (e.first_valid_at IS NOT NULL AND e.first_valid_at <= e.endpoint));

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- A failed transaction never reaches this point.  Successful ranges clear
  -- pending work only when they cover the complete pending interval; a
  -- partially covered interval is retained conservatively for retry.
  IF v_pending_from IS NULL THEN
    UPDATE analytics_refresh_state
       SET last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  ELSIF v_from <= v_pending_from AND v_through >= v_pending_through THEN
    UPDATE analytics_refresh_state
       SET pending_from_day = NULL, pending_through_day = NULL,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  ELSE
    UPDATE analytics_refresh_state
       SET last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  END IF;

  RETURN QUERY SELECT v_from, v_through, v_rows;
END
$$;

DROP VIEW IF EXISTS v_listing_daily;
CREATE VIEW v_listing_daily AS
SELECT d.day, d.article_id, l.title, l.url,
       d.category, d.category_memberships, d.is_rent,
       CASE WHEN d.is_rent THEN 'rent' ELSE 'sale' END AS deal,
       d.rooms, d.sqm, d.location, d.neighborhood,
       d.price, d.price_state, d.ppm2,
       d.state_effective_at, d.price_effective_at,
       d.membership_inferred, d.attributes_inferred,
       d.stale_observation, d.provisional_day, d.filter_attributes
  FROM listing_daily d
  JOIN listings l ON l.article_id = d.article_id;

DROP FUNCTION IF EXISTS market_daily_filtered(DATE, DATE, TEXT[], NUMERIC, NUMERIC, TEXT[], TEXT[], TEXT[]);
CREATE OR REPLACE FUNCTION market_daily_filtered(
  p_from_day DATE,
  p_through_day DATE,
  p_category TEXT[] DEFAULT '{}',
  p_min_sqm NUMERIC DEFAULT NULL,
  p_max_sqm NUMERIC DEFAULT NULL,
  p_rooms TEXT[] DEFAULT '{}',
  p_deal TEXT[] DEFAULT '{}',
  p_neighborhood TEXT[] DEFAULT '{}'
)
RETURNS TABLE (
  day DATE, inventory_count BIGINT, priced_count BIGINT,
  p25 NUMERIC, median NUMERIC, p75 NUMERIC,
  estimated_count BIGINT, stale_count BIGINT, provisional_day BOOLEAN
)
LANGUAGE sql STABLE AS $$
  SELECT d.day,
         count(*)::bigint,
         count(*) FILTER (WHERE d.price_state = 'valid' AND d.ppm2 IS NOT NULL)::bigint,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2)
           FILTER (WHERE d.price_state = 'valid' AND d.ppm2 IS NOT NULL),
         percentile_cont(0.50) WITHIN GROUP (ORDER BY d.ppm2)
           FILTER (WHERE d.price_state = 'valid' AND d.ppm2 IS NOT NULL),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2)
           FILTER (WHERE d.price_state = 'valid' AND d.ppm2 IS NOT NULL),
         count(*) FILTER (WHERE d.membership_inferred OR d.attributes_inferred)::bigint,
         count(*) FILTER (WHERE d.stale_observation)::bigint,
         bool_or(d.provisional_day)
    FROM listing_daily d
   WHERE d.day BETWEEN p_from_day AND LEAST(p_through_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date)
     AND (COALESCE(cardinality(p_category), 0) = 0
       OR d.category_memberships && p_category
       OR d.category = ANY (p_category))
     AND (p_min_sqm IS NULL OR d.sqm IS NULL OR d.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR d.sqm IS NULL OR d.sqm <= p_max_sqm)
     AND (COALESCE(cardinality(p_rooms), 0) = 0
       OR d.rooms = ANY (p_rooms) OR room_bucket(d.rooms) = ANY (p_rooms))
     AND (COALESCE(cardinality(p_deal), 0) = 0
       OR (CASE WHEN d.is_rent THEN 'rent' ELSE 'sale' END) = ANY (p_deal))
     AND (COALESCE(cardinality(p_neighborhood), 0) = 0
       OR d.neighborhood = ANY (p_neighborhood)
       OR d.location = ANY (p_neighborhood))
   GROUP BY d.day
   ORDER BY d.day
$$;

DROP VIEW IF EXISTS v_listing_price_changes;
CREATE VIEW v_listing_price_changes AS
WITH state_at_event AS (
    SELECT e.*,
         s.is_rent,
         s.sqm,
         s.rooms,
         s.category,
         s.category_membership,
         s.filter_attributes,
         COALESCE(s.category_membership, '{}'::text[]) AS memberships
    FROM listing_price_events e
    LEFT JOIN LATERAL (
      SELECT h.* FROM listing_state_history h
       WHERE h.article_id = e.article_id AND h.effective_at <= e.effective_at
       ORDER BY h.effective_at DESC, h.id DESC LIMIT 1
    ) s ON TRUE
   WHERE NOT (e.source LIKE 'legacy%'
              AND EXISTS (SELECT 1 FROM listing_price_events newer
                           WHERE newer.article_id = e.article_id
                             AND newer.effective_at = e.effective_at
                             AND newer.source IN ('search', 'detail')))
), ordered AS (
  SELECT x.*,
         lag(x.price) OVER w AS prior_price,
         lag(x.price_state) OVER w AS prior_state,
         lag(x.effective_at) OVER w AS prior_effective_at,
         lag(CASE WHEN x.is_rent THEN 'rent' ELSE 'sale' END) OVER w AS prior_deal
    FROM state_at_event x
  WINDOW w AS (PARTITION BY x.article_id ORDER BY x.effective_at, x.id)
)
SELECT article_id, effective_at, ingested_at, source, price, price_state,
       CASE WHEN is_rent THEN 'rent' ELSE 'sale' END AS deal,
       prior_price,
       CASE WHEN price_state = 'valid' AND prior_state = 'valid'
            THEN price - prior_price END AS delta,
       CASE WHEN price_state = 'valid' AND prior_state = 'valid'
                  AND prior_price <> 0
            THEN (price - prior_price) / prior_price * 100 END AS pct_change,
       prior_effective_at,
       effective_at AS current_effective_at,
       category, category_membership AS category_memberships, sqm, rooms,
       filter_attributes AS provenance,
       (price_state <> 'valid') AS null_boundary
  FROM ordered
 WHERE price_state = 'valid'
   AND price IS NOT NULL
   AND prior_state = 'valid'
   AND price IS DISTINCT FROM prior_price;

DROP VIEW IF EXISTS v_listing_lifecycle_cycles;
CREATE VIEW v_listing_lifecycle_cycles AS
WITH markers AS (
  SELECT article_id, effective_at AS opened_at, id AS marker_id
    FROM (
      SELECT DISTINCT ON (article_id) article_id, effective_at, id
        FROM listing_state_history
       WHERE event_type = 'search_sighting'
       ORDER BY article_id, effective_at, id
    ) first_search
  UNION ALL
  SELECT article_id, effective_at, id
    FROM listing_state_history WHERE event_type = 'reopened'
),
numbered AS (
  SELECT m.*, row_number() OVER (PARTITION BY article_id ORDER BY opened_at, marker_id) AS cycle_no,
         lead(opened_at) OVER (PARTITION BY article_id ORDER BY opened_at, marker_id) AS next_opened_at
    FROM markers m
),
cycles AS (
  SELECT n.*,
         c.closed_at
    FROM numbered n
    LEFT JOIN LATERAL (
      SELECT s.effective_at AS closed_at
        FROM listing_state_history s
       WHERE s.article_id = n.article_id AND s.event_type = 'closed'
         AND s.effective_at >= n.opened_at
         AND (n.next_opened_at IS NULL OR s.effective_at < n.next_opened_at)
       ORDER BY s.effective_at, s.id LIMIT 1
    ) c ON TRUE
)
SELECT c.article_id, c.cycle_no, c.opened_at, c.closed_at,
       fp.effective_at AS first_price_at, fp.price AS opening_price,
       (c.closed_at IS NOT NULL) AS is_closed,
       CASE WHEN c.closed_at IS NULL THEN NULL
            ELSE greatest(round(extract(epoch FROM (c.closed_at - c.opened_at)) / 86400.0)::int, 0) END AS days_listed
  FROM cycles c
  LEFT JOIN LATERAL (
    SELECT e.effective_at, e.price FROM listing_price_events e
     WHERE e.article_id = c.article_id AND e.price_state = 'valid'
       AND e.effective_at >= c.opened_at
       AND (c.closed_at IS NULL OR e.effective_at <= c.closed_at)
     ORDER BY e.effective_at, e.id LIMIT 1
  ) fp ON TRUE;

DROP VIEW IF EXISTS v_listing_lifecycle;
CREATE VIEW v_listing_lifecycle AS
WITH first_state AS (
  SELECT DISTINCT ON (article_id) * FROM listing_state_history
   WHERE event_type IN ('search_sighting', 'reopened')
   ORDER BY article_id, effective_at, id
),
last_state AS (
  SELECT DISTINCT ON (article_id) article_id, event_type, effective_at
    FROM listing_state_history
   WHERE event_type IN ('search_sighting', 'closed', 'reopened')
   ORDER BY article_id, effective_at DESC, id DESC
),
prices AS (
  SELECT e.article_id, min(e.effective_at) AS first_price_at,
         (array_agg(e.price ORDER BY e.effective_at, e.id))[1] AS opening_price,
         NULL::numeric AS opening_ppm2,
         max(e.effective_at) AS last_change_at,
         (array_agg(e.price ORDER BY e.effective_at DESC, e.id DESC))[1] AS last_history_price,
         NULL::numeric AS last_history_ppm2,
         count(*)::int AS n_changes, min(e.price) AS min_price, max(e.price) AS max_price
    FROM listing_price_events e
   WHERE e.price_state = 'valid'
   GROUP BY e.article_id
)
SELECT l.article_id, l.title, l.url, fs.sqm, fs.rooms, room_bucket(fs.rooms) AS room_bucket,
       fs.is_rent,
       COALESCE(fs.category, l.closing_category, (SELECT ss.category FROM search_results sr
                              JOIN saved_searches ss USING (search_key)
                              WHERE sr.article_id = l.article_id
                              ORDER BY ss.created_at LIMIT 1)) AS category,
       fs.category_membership AS category_memberships,
       COALESCE(fs.effective_at, l.first_seen) AS opened_at, p.first_price_at, p.opening_price,
       p.opening_ppm2, p.last_change_at, p.last_history_price, p.last_history_ppm2,
       p.n_changes, p.min_price, p.max_price,
       l.price AS current_price, l.ppm2 AS current_ppm2,
       CASE WHEN ls.event_type = 'closed' THEN ls.effective_at END AS closed_at,
       l.closing_price, l.closing_ppm2, l.closing_category,
       COALESCE(ls.event_type = 'closed', l.closed_at IS NOT NULL, false) AS is_closed,
       (SELECT count(*)::int FROM listing_state_history r
         WHERE r.article_id = l.article_id AND r.event_type = 'reopened') AS reopen_count,
       l.published_at, l.renewed_at, COALESCE(fs.effective_at, l.first_seen) AS first_seen,
       CASE WHEN COALESCE(fs.effective_at, l.first_seen) IS NULL THEN NULL ELSE
         greatest(round(extract(epoch FROM (COALESCE(CASE WHEN ls.event_type = 'closed' THEN ls.effective_at ELSE l.closed_at END, now()) - COALESCE(fs.effective_at, l.first_seen))) / 86400.0)::int, 0)
       END AS days_listed,
       CASE WHEN l.renewed_at IS NOT NULL THEN
         greatest(round(extract(epoch FROM
           (COALESCE(CASE WHEN ls.event_type = 'closed' THEN ls.effective_at END, now()) - l.renewed_at)) / 86400.0)::int, 0)
       END AS days_since_renewal
  FROM listings l
  LEFT JOIN first_state fs ON fs.article_id = l.article_id
  LEFT JOIN last_state ls ON ls.article_id = l.article_id
  LEFT JOIN prices p ON p.article_id = l.article_id;

DROP VIEW IF EXISTS v_market_daily;
CREATE VIEW v_market_daily AS
WITH bounds AS (
  SELECT min(day) AS first_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date AS last_day
    FROM listing_daily
), grid AS (
  SELECT d::date AS day FROM bounds b
   CROSS JOIN LATERAL generate_series(COALESCE(b.first_day, b.last_day), b.last_day, interval '1 day') s(d)
), flows AS (
  SELECT day, sum(new_n)::int AS new_n, sum(closed_n)::int AS closed_n,
         sum(reopened_n)::int AS reopened_n
    FROM (
      SELECT (effective_at AT TIME ZONE 'Europe/Sarajevo')::date AS day,
             count(*) FILTER (WHERE event_type = 'search_sighting')::int AS new_n,
             count(*) FILTER (WHERE event_type = 'closed')::int AS closed_n,
             count(*) FILTER (WHERE event_type = 'reopened')::int AS reopened_n
        FROM listing_state_history
       WHERE event_type IN ('search_sighting', 'closed', 'reopened')
       GROUP BY 1
      UNION ALL
      SELECT (l.first_seen AT TIME ZONE 'Europe/Sarajevo')::date, 1, 0, 0
        FROM listings l
       WHERE NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id = l.article_id)
      UNION ALL
      SELECT (l.closed_at AT TIME ZONE 'Europe/Sarajevo')::date, 0, 1, 0
        FROM listings l
       WHERE l.closed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id = l.article_id)
    ) events
   GROUP BY day
), inventory_raw AS (
  SELECT day, count(*)::int AS active_est,
         count(*) FILTER (WHERE stale_observation)::int AS stale_n,
         bool_or(provisional_day) AS provisional_day
    FROM listing_daily GROUP BY day
  UNION ALL
  SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date,
         count(*)::int, 0, true
    FROM listings l
   WHERE l.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id = l.article_id)
), inventory AS (
  SELECT day, sum(active_est)::int AS active_est, sum(stale_n)::int AS stale_n,
         bool_or(provisional_day) AS provisional_day
    FROM inventory_raw GROUP BY day
)
SELECT g.day, COALESCE(f.new_n, 0) AS new_n, COALESCE(f.closed_n, 0) AS closed_n,
       COALESCE(f.reopened_n, 0) AS reopened_n,
       COALESCE(i.active_est, 0) AS active_est,
       COALESCE(i.stale_n, 0) AS stale_n,
       COALESCE(i.provisional_day, g.day = (now() AT TIME ZONE 'Europe/Sarajevo')::date) AS provisional_day
  FROM grid g LEFT JOIN flows f USING (day) LEFT JOIN inventory i USING (day)
 ORDER BY g.day;
