-- Dashboard input parsing and shared filters.

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

CREATE OR REPLACE FUNCTION price_changes_filtered(
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
