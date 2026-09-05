-- Derive historical neighborhood values from stored observations.
CREATE OR REPLACE FUNCTION analytics_state_neighborhood(p_attributes JSONB)
RETURNS TEXT LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  v_name TEXT;
  v_lat DOUBLE PRECISION;
  v_lon DOUBLE PRECISION;
BEGIN
  v_name := COALESCE(NULLIF(p_attributes->>'location', ''),
    NULLIF(p_attributes->>'neighborhood', ''), NULLIF(p_attributes->>'district', ''),
    NULLIF(p_attributes->'searchAttributes'->>'location', ''),
    NULLIF(p_attributes->'searchAttributes'->>'neighborhood', ''),
    NULLIF(p_attributes->'searchAttributes'->>'district', ''));
  IF v_name IS NOT NULL THEN RETURN v_name; END IF;
  BEGIN
    v_lat := NULLIF(COALESCE(p_attributes->>'latitude', p_attributes->'searchAttributes'->>'latitude'), '')::double precision;
    v_lon := NULLIF(COALESCE(p_attributes->>'longitude', p_attributes->'searchAttributes'->>'longitude'), '')::double precision;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN '(unmapped)';
  END;
  IF v_lat IS NULL OR v_lon IS NULL THEN RETURN '(no pin)'; END IF;
  RETURN COALESCE(neighborhood_of(v_lat, v_lon), '(unmapped)');
END
$$;

-- Normalize both location columns on every rebuild.
CREATE OR REPLACE FUNCTION normalize_listing_daily_flags()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.membership_inferred := COALESCE(NEW.membership_inferred, false);
  NEW.attributes_inferred := COALESCE(NEW.attributes_inferred, false);
  IF TG_OP = 'INSERT' OR NEW.neighborhood IS NULL
     OR NEW.filter_attributes IS DISTINCT FROM OLD.filter_attributes THEN
    NEW.location := analytics_state_neighborhood(NEW.filter_attributes);
    NEW.neighborhood := NEW.location;
  END IF;
  RETURN NEW;
END
$$;

-- Many days share one observation; evaluate expensive polygons once per
-- distinct observation instead of twice for every listing-day.
WITH attributes AS MATERIALIZED (
  SELECT DISTINCT filter_attributes FROM listing_daily
), resolved AS MATERIALIZED (
  SELECT filter_attributes, analytics_state_neighborhood(filter_attributes) AS name
    FROM attributes
)
UPDATE listing_daily d SET neighborhood = r.name, location = r.name
  FROM resolved r WHERE r.filter_attributes = d.filter_attributes;

-- A search sighting is a repeat observation, often dated at the ad's renewal.
-- first_seen is the durable first discovery date, one addition per article.
CREATE OR REPLACE VIEW v_market_daily AS
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
             0::int AS new_n,
             count(*) FILTER (WHERE event_type = 'closed')::int AS closed_n,
             count(*) FILTER (WHERE event_type = 'reopened')::int AS reopened_n
        FROM listing_state_history
       WHERE event_type IN ('closed', 'reopened')
       GROUP BY 1
      UNION ALL
      SELECT (l.first_seen AT TIME ZONE 'Europe/Sarajevo')::date, 1, 0, 0
        FROM listings l
      UNION ALL
      SELECT (l.closed_at AT TIME ZONE 'Europe/Sarajevo')::date, 0, 1, 0
        FROM listings l
       WHERE l.closed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id = l.article_id AND h.event_type = 'closed' AND h.effective_at = l.closed_at)
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
