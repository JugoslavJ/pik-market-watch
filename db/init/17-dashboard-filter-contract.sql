-- Dashboard filter contract (G1-G3).
--
-- Grafana variables are still text at interpolation time.  This helper keeps
-- malformed textbox values from aborting a panel query while allowing the
-- database functions to retain numeric arguments and query plans.
CREATE OR REPLACE FUNCTION dashboard_numeric(p_value TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  v_value NUMERIC;
BEGIN
  IF btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(p_value) !~ '^[+]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$' THEN
    RETURN NULL;
  END IF;
  v_value := btrim(p_value)::NUMERIC;
  IF v_value < 0 THEN
    RETURN NULL;
  END IF;
  RETURN v_value;
EXCEPTION
  WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN NULL;
END
$$;

-- Current inventory: empty category means all categories, bounds are
-- independently optional, and active inventory excludes explicitly closed
-- listings as well as stale sightings.
CREATE OR REPLACE FUNCTION listings_filtered(
  p_category TEXT[],
  p_min_sqm NUMERIC,
  p_max_sqm NUMERIC,
  p_neighborhood TEXT[],
  p_active_only BOOLEAN DEFAULT TRUE
)
RETURNS SETOF listings
LANGUAGE sql STABLE AS $$
  SELECT l.*
    FROM listings l
   WHERE (NOT p_active_only
          OR (l.closed_at IS NULL
              AND l.last_seen > now() - INTERVAL '14 days'))
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (COALESCE(cardinality(p_neighborhood), 0) = 0
          OR COALESCE(NULLIF(l.location, ''),
                      CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
              = ANY (p_neighborhood))
     AND (COALESCE(cardinality(p_category), 0) = 0
          OR EXISTS (
               SELECT 1
                 FROM search_results sr
                 JOIN saved_searches ss ON ss.search_key = sr.search_key
                WHERE sr.article_id = l.article_id
                  AND ss.category = ANY (p_category)))
$$;

-- Closed inventory: the frozen closing category remains the first source,
-- with search membership as a compatibility fallback for older closures.
CREATE OR REPLACE FUNCTION listings_closed_filtered(
  p_category TEXT[],
  p_min_sqm NUMERIC,
  p_max_sqm NUMERIC,
  p_neighborhood TEXT[]
)
RETURNS SETOF listings
LANGUAGE sql STABLE AS $$
  SELECT l.*
    FROM listings l
   WHERE l.closed_at IS NOT NULL
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (COALESCE(cardinality(p_neighborhood), 0) = 0
          OR COALESCE(NULLIF(l.location, ''),
                      CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
              = ANY (p_neighborhood))
     AND (COALESCE(cardinality(p_category), 0) = 0
          OR l.closing_category = ANY (p_category)
          OR EXISTS (
               SELECT 1
                 FROM search_results sr
                 JOIN saved_searches ss ON ss.search_key = sr.search_key
                WHERE sr.article_id = l.article_id
                  AND ss.category = ANY (p_category)))
$$;

-- Price changes filtered by the attributes stored with the event.  This is
-- for "cuts observed in a period" panels; current active-listing panels keep
-- their separate join to listings_filtered.  Deal accepts both the legacy
-- dashboard spelling (sell) and the canonical database spelling (sale).
DROP FUNCTION IF EXISTS price_changes_filtered(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], NUMERIC, NUMERIC, TEXT[], TEXT[], TEXT[]);
CREATE FUNCTION price_changes_filtered(
  p_from TIMESTAMPTZ,
  p_through TIMESTAMPTZ,
  p_category TEXT[] DEFAULT '{}',
  p_min_sqm NUMERIC DEFAULT NULL,
  p_max_sqm NUMERIC DEFAULT NULL,
  p_rooms TEXT[] DEFAULT '{}',
  p_deal TEXT[] DEFAULT '{}',
  p_neighborhood TEXT[] DEFAULT '{}'
)
RETURNS SETOF v_listing_price_changes
LANGUAGE sql STABLE AS $$
  SELECT pc.*
    FROM v_listing_price_changes pc
   WHERE pc.effective_at >= p_from
     AND pc.effective_at < p_through
     AND (COALESCE(cardinality(p_category), 0) = 0
          OR pc.category_memberships && p_category
          OR pc.category = ANY (p_category))
     AND (p_min_sqm IS NULL OR pc.sqm IS NULL OR pc.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR pc.sqm IS NULL OR pc.sqm <= p_max_sqm)
     AND (COALESCE(cardinality(p_rooms), 0) = 0
          OR pc.rooms = ANY (p_rooms)
          OR room_bucket(pc.rooms) = ANY (p_rooms))
     AND (COALESCE(cardinality(p_deal), 0) = 0
          OR (CASE WHEN pc.deal = 'sell' THEN 'sale' ELSE pc.deal END)
             = ANY (
               SELECT CASE WHEN selected = 'sell' THEN 'sale' ELSE selected END
                 FROM unnest(p_deal) AS selected))
     AND (COALESCE(cardinality(p_neighborhood), 0) = 0
          OR analytics_state_neighborhood(pc.provenance) = ANY (p_neighborhood))
$$;
