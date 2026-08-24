-- ─────────────────────────────────────────────────────────────────────────────
-- Neighborhood filter replaces the lat/lon bounding box.
--
-- With locations assigned from map pins (11-neighborhoods.sql), the dashboards
-- filter by district instead of a hand-tuned bounding box — the bbox
-- "pass-through defaults" hack (42.4/46.4/15.5/19.6 = no constraint) is gone.
--
-- Semantics of p_neighborhood:
--   NULL / empty array   no constraint (every row passes)
--   districts            COALESCE(NULLIF(location,''), …) must match; rows
--                        without a stored location map to virtual buckets:
--                          '(no pin)'    no coordinates at all
--                          '(unmapped)'  pin outside every district
--                        — the same buckets the Grafana variable offers, so
--                        unassigned rows stay selectable.
-- The empty-array pass-through also degrades gracefully if a variable ever
-- expands empty: panels show everything instead of erroring.
--
-- Idempotent; applied automatically by the scraper on startup, or once with:
--   docker exec -i olx-db psql -U olx_app -d olx < db/init/12-neighborhood-filter.sql
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS listings_filtered(TEXT[], NUMERIC, NUMERIC,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN);
CREATE FUNCTION listings_filtered(
  p_category TEXT[],
  p_min_sqm  NUMERIC,
  p_max_sqm  NUMERIC,
  p_neighborhood TEXT[],
  p_active_only BOOLEAN DEFAULT TRUE
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.*
  FROM listings l
  WHERE (NOT p_active_only OR l.last_seen > now() - INTERVAL '14 days')
    AND (l.sqm IS NULL OR l.sqm BETWEEN p_min_sqm AND p_max_sqm)
    AND (COALESCE(cardinality(p_neighborhood), 0) = 0
         OR COALESCE(NULLIF(l.location, ''),
                     CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
             = ANY (p_neighborhood))
    AND EXISTS (
      SELECT 1 FROM search_results sr
      JOIN saved_searches ss ON ss.search_key = sr.search_key
      WHERE sr.article_id = l.article_id AND ss.category = ANY (p_category))
$$;

DROP FUNCTION IF EXISTS listings_closed_filtered(TEXT[], NUMERIC, NUMERIC,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);
CREATE FUNCTION listings_closed_filtered(
  p_category TEXT[],
  p_min_sqm  NUMERIC,
  p_max_sqm  NUMERIC,
  p_neighborhood TEXT[]
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.*
  FROM listings l
  WHERE l.closed_at IS NOT NULL
    AND (l.sqm IS NULL OR l.sqm BETWEEN p_min_sqm AND p_max_sqm)
    AND (COALESCE(cardinality(p_neighborhood), 0) = 0
         OR COALESCE(NULLIF(l.location, ''),
                     CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
             = ANY (p_neighborhood))
    AND (l.closing_category = ANY (p_category)
         OR EXISTS (
           SELECT 1 FROM search_results sr
           JOIN saved_searches ss ON ss.search_key = sr.search_key
           WHERE sr.article_id = l.article_id AND ss.category = ANY (p_category)))
$$;
