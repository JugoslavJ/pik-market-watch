-- Shared listing-filter helpers for the Grafana dashboard (idempotent).
-- Every panel applies the same core filters (category, m² range, lat/lon
-- bounding box with pass-through defaults, optional 14-day recency). Those
-- conditions used to be copy-pasted into ten panel queries; these functions
-- give them a single home.
--
-- Fresh installs get this automatically (db/init runs on FIRST start only).
-- Existing volumes: apply once manually —
--   docker exec -i olx-db psql -U olx -d olx < db/init/03-listing-filters.sql

-- Room-count bucket used by the Rooms dropdown, the bar gauge and every
-- filtered panel: ''/NULL → 'unknown', non-numeric → 'other',
-- 4 or more (incl. '4+') → '4+', otherwise the raw value ('0'..'3').
CREATE OR REPLACE FUNCTION room_bucket(rooms TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN COALESCE(rooms, '') = ''            THEN 'unknown'
              WHEN rooms !~ '^[0-9]'                   THEN 'other'
              WHEN split_part(rooms, '+', 1)::int >= 4 THEN '4+'
              ELSE rooms END;
$$;

-- Listings matching the dashboard-wide filters. Panel-specific conditions
-- (is_rent, ppm2 > 0, deal, GROUP BY, LIMIT …) stay in the panel queries.
-- Bounding-box pass-through is preserved: when min/max still equal the BiH
-- defaults, the box does not constrain anything.
-- p_active_only = false opts out of the 14-day recency window of
-- v_active_listings (the price-drops panel intentionally scans full history).
CREATE OR REPLACE FUNCTION listings_filtered(
  p_category TEXT[],
  p_min_sqm  NUMERIC,
  p_max_sqm  NUMERIC,
  p_min_lat  DOUBLE PRECISION,
  p_max_lat  DOUBLE PRECISION,
  p_min_lon  DOUBLE PRECISION,
  p_max_lon  DOUBLE PRECISION,
  p_active_only BOOLEAN DEFAULT TRUE
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.*
  FROM listings l
  WHERE (NOT p_active_only OR l.last_seen > now() - INTERVAL '14 days')
    AND (l.sqm IS NULL OR l.sqm BETWEEN p_min_sqm AND p_max_sqm)
    AND EXISTS (
      SELECT 1 FROM search_results sr
      JOIN saved_searches ss ON ss.search_key = sr.search_key
      WHERE sr.article_id = l.article_id AND ss.category = ANY (p_category))
    AND ( (p_min_lat <= 42.4 AND p_max_lat >= 46.4
       AND p_min_lon <= 15.5 AND p_max_lon >= 19.6)
       OR (l.latitude IS NOT NULL AND l.latitude BETWEEN p_min_lat AND p_max_lat
                                 AND l.longitude BETWEEN p_min_lon AND p_max_lon) );
$$;
