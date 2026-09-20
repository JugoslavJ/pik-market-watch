-- Canonical persona scopes baseline.

-- Private persona scope functions included in the canonical baseline.
--
CREATE OR REPLACE FUNCTION reporting.agent_listing_scope(
  p_deal text,
  p_property_type text,
  p_neighborhoods text[],
  p_rooms text[],
  p_min_area text,
  p_max_area text,
  p_conditions text[],
  p_furnishing text[],
  p_parking text[],
  p_seller_types text[],
  p_min_price text,
  p_max_price text,
  p_min_rate text,
  p_max_rate text,
  p_min_score text,
  p_max_score text,
  p_view text,
  p_pricing_position text,
  p_review_signals text[],
  p_analysis_days text,
  p_apply_result_filters boolean DEFAULT true
) RETURNS SETOF olap.current_listing_scores
    LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
    SET search_path TO pg_catalog, reporting, olap
    AS $$
  WITH validation AS MATERIALIZED (
    SELECT reporting.within_bounds(NULL::numeric, p_min_price, p_max_price, 'asking price for selected deal') AS min_price_ok,
           reporting.within_bounds(NULL::numeric, p_min_rate, p_max_rate, 'asking rate for selected deal') AS min_rate_ok,
           reporting.within_bounds(NULL::numeric, p_min_area, p_max_area, 'area') AS min_area_ok,
           reporting.within_bounds(NULL::numeric, p_min_score, p_max_score, 'score', 100) AS min_score_ok,
           reporting.numeric_bound(p_analysis_days, 'analysis window', 90) AS analysis_days
  )
  SELECT s.*
    FROM olap.current_listing_scores s
    CROSS JOIN validation v
   WHERE s.deal = p_deal
     AND COALESCE(s.property_type, 'unknown') = p_property_type
     AND (('__mapped__' = ANY (p_neighborhoods) AND s.neighborhood IS NOT NULL)
          OR COALESCE(s.neighborhood, 'unknown') = ANY (p_neighborhoods))
     AND ('__any__' = ANY (p_rooms)
          OR COALESCE(s.room_bucket, 'unknown') = ANY (p_rooms))
     AND reporting.within_bounds(s.sqm, p_min_area, p_max_area, 'area')
     AND ('__any__' = ANY (p_conditions)
          OR COALESCE(s.condition::text, 'unknown') = ANY (p_conditions))
     AND ('__any__' = ANY (p_furnishing)
          OR COALESCE(s.furnished::text, 'unknown') = ANY (p_furnishing))
     AND ('__any__' = ANY (p_parking)
          OR COALESCE(s.parking::text, 'unknown') = ANY (p_parking))
     AND ('__any__' = ANY (p_seller_types)
          OR COALESCE(s.seller_type::text, 'unknown') = ANY (p_seller_types))
     AND (
       NOT p_apply_result_filters
       OR (
         reporting.within_bounds(s.asking_price, p_min_price, p_max_price, 'asking price for selected deal')
         AND reporting.within_bounds(s.asking_rate, p_min_rate, p_max_rate, 'asking rate for selected deal')
         AND reporting.within_bounds(s.score, p_min_score, p_max_score, 'score', 100)
         AND CASE p_view
               WHEN 'below' THEN s.deviation_pct < -5
               WHEN 'above' THEN s.deviation_pct > 5
               WHEN 'long_above' THEN s.current_cycle_age_days >= 60 AND s.deviation_pct > 5
               WHEN 'reductions' THEN s.latest_reduction_at >= now() - make_interval(days => v.analysis_days::int)
               WHEN 'new' THEN s.first_seen >= now() - INTERVAL '7 days'
               WHEN 'evidence' THEN s.score IS NULL
               ELSE TRUE
             END
         AND CASE p_pricing_position
               WHEN 'below' THEN s.deviation_pct < -5
               WHEN 'near' THEN s.deviation_pct BETWEEN -5 AND 5
               WHEN 'above' THEN s.deviation_pct > 5
               WHEN 'unscored' THEN s.score IS NULL
               ELSE TRUE
             END
         AND ('__any__' = ANY (p_review_signals)
              OR ('new' = ANY (p_review_signals) AND s.first_seen >= now() - INTERVAL '7 days')
              OR ('reduced' = ANY (p_review_signals) AND s.latest_reduction_at >= now() - make_interval(days => v.analysis_days::int))
              OR ('long' = ANY (p_review_signals) AND s.current_cycle_age_days >= 60))
       )
     )
$$;

REVOKE EXECUTE ON FUNCTION reporting.agent_listing_scope(
  text, text, text[], text[], text, text, text[], text[], text[], text[],
  text, text, text, text, text, text, text, text, text[], text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.agent_listing_scope(
  text, text, text[], text[], text, text, text[], text[], text[], text[],
  text, text, text, text, text, text, text, text, text[], text, boolean
) TO pg_read_all_data;

COMMENT ON FUNCTION reporting.agent_listing_scope(
  text, text, text[], text[], text, text, text[], text[], text[], text[],
  text, text, text, text, text, text, text, text, text[], text, boolean
) IS 'Canonical current-listing scope for the private agent dashboard; validates all bounds and optionally applies result-only workflow filters.';

CREATE OR REPLACE FUNCTION reporting.buyer_listing_scope(
  p_property_type text, p_neighborhoods text[], p_rooms text[],
  p_min_area text, p_max_area text, p_conditions text[], p_parking text[],
  p_garage text[], p_elevator text[], p_floors text[], p_seller_types text[],
  p_min_price text, p_max_price text, p_min_rate text, p_max_rate text,
  p_min_score text, p_max_score text, p_listing_selection text,
  p_apply_result_filters boolean DEFAULT true
) RETURNS SETOF olap.current_listing_scores
    LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
    SET search_path TO pg_catalog, reporting, olap
    AS $$
  WITH validation AS MATERIALIZED (
    SELECT reporting.within_bounds(NULL::numeric, p_min_price, p_max_price, 'asking price'),
           reporting.within_bounds(NULL::numeric, p_min_rate, p_max_rate, 'asking price per m²'),
           reporting.within_bounds(NULL::numeric, p_min_area, p_max_area, 'area'),
           reporting.within_bounds(NULL::numeric, p_min_score, p_max_score, 'score', 100)
  )
  SELECT s.* FROM olap.current_listing_scores s CROSS JOIN validation
   WHERE s.deal = 'sale'
     AND COALESCE(s.property_type, 'unknown') = p_property_type
     AND (('__mapped__' = ANY (p_neighborhoods) AND s.neighborhood IS NOT NULL)
          OR COALESCE(s.neighborhood, 'unknown') = ANY (p_neighborhoods))
     AND ('__any__' = ANY (p_rooms) OR COALESCE(s.room_bucket, 'unknown') = ANY (p_rooms))
     AND reporting.within_bounds(s.sqm, p_min_area, p_max_area, 'area')
     AND ('__any__' = ANY (p_conditions) OR COALESCE(s.condition::text, 'unknown') = ANY (p_conditions))
     AND ('__any__' = ANY (p_parking) OR COALESCE(s.parking::text, 'unknown') = ANY (p_parking))
     AND ('__any__' = ANY (p_garage) OR COALESCE(s.garage::text, 'unknown') = ANY (p_garage))
     AND ('__any__' = ANY (p_elevator) OR COALESCE(s.elevator::text, 'unknown') = ANY (p_elevator))
     AND ('__any__' = ANY (p_floors) OR COALESCE(s.floor_num::text, 'unknown') = ANY (p_floors))
     AND ('__any__' = ANY (p_seller_types) OR COALESCE(s.seller_type::text, 'unknown') = ANY (p_seller_types))
     AND (NOT p_apply_result_filters OR (
       reporting.within_bounds(s.asking_price, p_min_price, p_max_price, 'asking price')
       AND reporting.within_bounds(s.asking_rate, p_min_rate, p_max_rate, 'asking price per m²')
       AND reporting.within_bounds(s.score, p_min_score, p_max_score, 'score', 100)
       AND CASE p_listing_selection
             WHEN 'new' THEN s.first_seen >= now() - INTERVAL '7 days'
             WHEN 'reduced' THEN s.latest_reduction_at >= now() - INTERVAL '30 days'
             WHEN 'below' THEN s.deviation_pct < -5
             ELSE TRUE
           END
     ))
$$;

REVOKE EXECUTE ON FUNCTION reporting.buyer_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.buyer_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean) TO pg_read_all_data;
COMMENT ON FUNCTION reporting.buyer_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean) IS 'Canonical current-listing scope for the private buyer dashboard; optionally applies price, score, and listing-selection filters.';

CREATE OR REPLACE FUNCTION reporting.renter_listing_scope(
  p_property_type text, p_neighborhoods text[], p_rooms text[],
  p_min_area text, p_max_area text, p_furnishing text[], p_heating text[],
  p_parking text[], p_elevator text[], p_floors text[], p_seller_types text[],
  p_min_price text, p_max_price text, p_min_rate text, p_max_rate text,
  p_min_score text, p_max_score text, p_listing_selection text,
  p_apply_result_filters boolean DEFAULT true
) RETURNS SETOF olap.current_listing_scores
    LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
    SET search_path TO pg_catalog, reporting, olap
    AS $$
  WITH validation AS MATERIALIZED (
    SELECT reporting.within_bounds(NULL::numeric, p_min_price, p_max_price, 'monthly asking rent'),
           reporting.within_bounds(NULL::numeric, p_min_rate, p_max_rate, 'monthly rent per m²'),
           reporting.within_bounds(NULL::numeric, p_min_area, p_max_area, 'area'),
           reporting.within_bounds(NULL::numeric, p_min_score, p_max_score, 'score', 100)
  )
  SELECT s.* FROM olap.current_listing_scores s CROSS JOIN validation
   WHERE s.deal = 'rent'
     AND COALESCE(s.property_type, 'unknown') = p_property_type
     AND (('__mapped__' = ANY (p_neighborhoods) AND s.neighborhood IS NOT NULL)
          OR COALESCE(s.neighborhood, 'unknown') = ANY (p_neighborhoods))
     AND ('__any__' = ANY (p_rooms) OR COALESCE(s.room_bucket, 'unknown') = ANY (p_rooms))
     AND reporting.within_bounds(s.sqm, p_min_area, p_max_area, 'area')
     AND ('__any__' = ANY (p_furnishing) OR COALESCE(s.furnished::text, 'unknown') = ANY (p_furnishing))
     AND ('__any__' = ANY (p_heating) OR COALESCE(s.heating::text, 'unknown') = ANY (p_heating))
     AND ('__any__' = ANY (p_parking) OR COALESCE(s.parking::text, 'unknown') = ANY (p_parking))
     AND ('__any__' = ANY (p_elevator) OR COALESCE(s.elevator::text, 'unknown') = ANY (p_elevator))
     AND ('__any__' = ANY (p_floors) OR COALESCE(s.floor_num::text, 'unknown') = ANY (p_floors))
     AND ('__any__' = ANY (p_seller_types) OR COALESCE(s.seller_type::text, 'unknown') = ANY (p_seller_types))
     AND (NOT p_apply_result_filters OR (
       reporting.within_bounds(s.asking_price, p_min_price, p_max_price, 'monthly asking rent')
       AND reporting.within_bounds(s.asking_rate, p_min_rate, p_max_rate, 'monthly rent per m²')
       AND reporting.within_bounds(s.score, p_min_score, p_max_score, 'score', 100)
       AND CASE p_listing_selection
             WHEN 'new' THEN s.first_seen >= now() - INTERVAL '7 days'
             WHEN 'reduced' THEN s.latest_reduction_at >= now() - INTERVAL '30 days'
             WHEN 'below' THEN s.deviation_pct < -5
             ELSE TRUE
           END
     ))
$$;

REVOKE EXECUTE ON FUNCTION reporting.renter_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reporting.renter_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean) TO pg_read_all_data;
COMMENT ON FUNCTION reporting.renter_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean) IS 'Canonical current-listing scope for the private renter dashboard; optionally applies price, score, and listing-selection filters.';
