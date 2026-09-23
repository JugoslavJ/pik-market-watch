-- Canonical reporting views baseline.
--
-- Name: VIEW listing_state_history_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.listing_state_history_state IS 'Compatibility projection of listing_state_history joined to its canonical state version.';

--
-- Name: dashboard_listings; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.dashboard_listings AS
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    price,
    price_text,
    ppm2,
    is_rent,
    first_seen,
    last_seen,
    location,
    latitude,
    longitude,
    closed_at,
    closing_price,
    closing_ppm2,
    published_at,
    closing_category,
    seller_type,
    rooms_detail,
    bathrooms,
    floor_num,
    floors_total,
    unit_levels,
    heating,
    furnished,
    condition,
    parking,
    garage,
    elevator,
    year_built,
    plot_sqm,
    orientation,
    views,
    favorites,
    characteristics,
    details_fetched_at,
    api_price_history,
    api_status,
    last_enrichment_attempted_at,
    renewed_at
   FROM olap.listings;

-- Name: dashboard_filter_options; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.dashboard_filter_options AS
 SELECT filter_name, value, sort_order
   FROM olap.dashboard_filter_options;

--
-- Name: price_changes; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.price_changes AS
 SELECT article_id,
    effective_at,
    ingested_at,
    source,
    price,
    price_state,
    deal,
    prior_price,
    delta,
    pct_change,
    prior_effective_at,
    current_effective_at,
    category,
    category_memberships,
    sqm,
    rooms,
    provenance,
    null_boundary
   FROM olap.listing_price_changes;

--
-- Name: VIEW listing_daily_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.listing_daily_state IS 'Compatibility projection of listing_daily joined to its canonical state version.';

--
-- Name: v_active_listings; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_active_listings AS
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    price,
    price_text,
    ppm2,
    is_rent,
    location,
    latitude,
    longitude,
    closed_at,
    closing_price,
    closing_ppm2,
    closing_category,
    published_at,
    seller_type,
    rooms_detail,
    bathrooms,
    floor_num,
    floors_total,
    unit_levels,
    heating,
    furnished,
    condition,
    parking,
    garage,
    elevator,
    year_built,
    plot_sqm,
    orientation,
    views,
    favorites,
    characteristics,
    details_fetched_at,
    first_seen,
    last_seen,
    renewed_at
   FROM public.v_active_listings_source;

--
-- Name: v_listing_exit_economics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_exit_economics AS
 SELECT article_id,
    opening_price,
    days_listed
   FROM public.v_listing_exit_economics_source;

--
-- Name: v_market_daily; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_market_daily AS
 SELECT day,
    new_n,
    closed_n,
    reopened_n,
    active_est,
    stale_n,
    provisional_day
   FROM public.v_market_daily_source;

--
-- Name: analytics_refresh_state; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.analytics_refresh_state AS
 SELECT scope,
    pending_from_day,
    pending_through_day,
    completed_through_day,
    last_successful_refresh_at,
    updated_at
   FROM public.analytics_refresh_state;

--
-- Name: comparison_price_changes; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.comparison_price_changes AS
 SELECT article_id,
    effective_at,
    prior_effective_at,
    prior_price,
    price,
    delta,
    pct_change,
    deal,
    currency
   FROM olap.comparison_price_changes;

--
-- Name: current_listing_scores; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.current_listing_scores AS
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    is_rent,
    deal,
    latitude,
    longitude,
    first_seen,
    last_seen,
    seller_type,
    condition,
    parking,
    garage,
    elevator,
    heating,
    floor_num,
    plot_sqm,
    year_built,
    bathrooms,
    rooms_detail,
    furnished,
    category_memberships,
    property_type,
    neighborhood,
    room_bucket,
    resolved_price,
    price_state,
    currency,
    price_effective_at,
    evidence_is_rent,
    cycle_opened_at,
    current_cycle_age_days,
    reopened,
    benchmark_at,
    score_version,
    price_reason,
    asking_price,
    asking_rate,
    score_input_reason,
    comparable_count,
    benchmark_rate,
    benchmark_p25,
    benchmark_p75,
    deviation_pct,
    unscored_reason,
    confidence,
    score,
    position_label,
    indicative_total,
    indicative_low,
    indicative_high,
    asking_gap_km,
    latest_reduction_at,
    reduction_km,
    reduction_pct,
    local_comparable_count,
    benchmark_scope,
    benchmark_neighborhoods
   FROM olap.current_listing_scores s;

--
-- Name: daily_listing_facts; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.daily_listing_facts AS
 SELECT d.day,
    d.article_id,
    l.title,
    l.url,
    d.category,
    d.category_memberships,
    d.is_rent,
    f.deal,
    d.rooms,
    d.sqm,
    d.location,
    f.neighborhood,
    f.price,
    f.price_state,
    f.ppm2,
    f.state_effective_at,
    f.price_effective_at,
    d.membership_inferred,
    d.attributes_inferred,
    d.stale_observation,
    d.provisional_day,
    d.filter_attributes,
    f.property_type,
    f.room_bucket,
    f.currency,
    d.filter_attributes AS historical_attributes,
    f.historical_seller_type,
    f.historical_condition,
    f.historical_furnished,
    f.historical_heating,
    f.historical_parking,
    f.historical_garage,
    f.historical_elevator,
    f.historical_floor_num,
    f.price_quality_reason,
    f.rate_quality_reason,
    f.price_eligible,
    f.rate_eligible,
    f.asking_price,
    f.asking_rate,
    f.asking_price_unit,
    f.asking_rate_unit
   FROM ((olap.daily_listing_facts f
     LEFT JOIN public.listing_daily_state d ON (((d.day = f.day) AND (d.article_id = f.article_id))))
     LEFT JOIN public.listings l ON ((l.article_id = f.article_id)));

--
-- Name: evidence_timeline; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.evidence_timeline AS
 SELECT article_id,
    effective_at,
    observed_at,
    ingested_at,
    evidence_kind,
    state,
    price,
    source,
    provenance
   FROM public.v_listing_evidence_timeline;

--
-- Name: exit_economics; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.exit_economics AS
 SELECT article_id,
    opening_price,
    days_listed
   FROM olap.listing_exit_economics;

--
-- Name: freshness; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.freshness AS
 SELECT category,
    configured_searches,
    last_success_at
   FROM olap.public_freshness;

--
-- Name: history_contract; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.history_contract AS
 SELECT article_id,
    publication_at,
    publication_status,
    first_observed_at,
    first_supported_price_at,
    pre_observation_status,
    first_seen,
    closed_at
   FROM public.v_listing_history_contract;

--
-- Name: lifecycle_cycles; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.lifecycle_cycles AS
 SELECT article_id,
    cycle_no,
    opened_at,
    opened_day,
    closed_at,
    closed_day,
    is_closed,
    reopened_cycle,
    observed_cycle_duration_days,
    current_cycle_age_days,
    opening_category,
    opening_category_memberships,
    opening_deal,
    opening_property_type,
    opening_sqm,
    opening_rooms,
    opening_room_bucket,
    opening_neighborhood,
    opening_attributes,
    opening_membership_inferred,
    opening_attributes_inferred,
    closing_category,
    closing_category_memberships,
    closing_deal,
    closing_property_type,
    closing_sqm,
    closing_rooms,
    closing_room_bucket,
    closing_neighborhood,
    closing_attributes,
    closing_membership_inferred,
    closing_attributes_inferred,
    closing_price_effective_at,
    closing_price_state,
    closing_currency,
    closing_observed_price,
    closing_price_quality_reason,
    closing_rate_quality_reason,
    closing_price_eligible,
    closing_rate_eligible,
    final_asking_price,
    final_asking_rate,
    final_asking_price_unit,
    final_asking_rate_unit
   FROM olap.lifecycle_cycles;

--
-- Name: lifecycle_movements; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.lifecycle_movements AS
 SELECT movement_type,
    event_at,
    event_day,
    article_id,
    cycle_no,
    reopened_cycle,
    deal,
    property_type,
    category,
    category_memberships,
    sqm,
    rooms,
    room_bucket,
    neighborhood,
    historical_attributes,
    membership_inferred,
    attributes_inferred,
    price_state,
    currency,
    asking_price,
    asking_rate,
    price_eligible,
    rate_eligible,
    historical_seller_type,
    historical_condition,
    historical_furnished,
    historical_heating,
    historical_parking,
    historical_garage,
    historical_elevator,
    historical_floor_num
   FROM olap.lifecycle_movements;

--
-- Name: listing_health; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.listing_health AS
 SELECT article_id,
    closed_at,
    last_seen,
    latitude,
    longitude,
    sqm,
    price,
    ppm2,
    is_rent,
    api_status,
    details_fetched_at,
    last_enrichment_attempted_at
   FROM public.listings;

--
-- Name: market_daily; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.market_daily AS
 SELECT day,
    new_n,
    closed_n,
    reopened_n,
    active_est,
    stale_n,
    provisional_day
   FROM olap.market_daily;

--
-- Name: olap_health; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.olap_health AS
 SELECT max(refreshed_at) AS refreshed_at,
    min(refreshed_at) AS oldest_mart_at,
    (count(*))::integer AS tracked_marts,
    (count(DISTINCT refresh_id))::integer AS generation_count,
    ((count(DISTINCT refresh_id) = 1) AND (count(*) = 8)) AS generation_consistent,
    (max(refreshed_at) >= (now() - '02:00:00'::interval)) AS refresh_is_fresh,
    (max(EXTRACT(epoch FROM (now() - refreshed_at))))::bigint AS maximum_age_seconds,
    (sum(row_count))::bigint AS tracked_rows
   FROM olap.refresh_state;

--
-- Name: olap_queue_health; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.olap_queue_health AS
 SELECT count(*) AS pending_daily_partitions,
    min(day) AS oldest_pending_day,
    min(marked_at) AS oldest_pending_at,
    COALESCE((EXTRACT(epoch FROM (now() - min(marked_at))))::bigint, (0)::bigint) AS oldest_pending_seconds,
    ((count(*) = 0) OR (min(marked_at) >= (now() - '02:00:00'::interval))) AS daily_queue_healthy
   FROM public.analytics_daily_olap_dirty;

--
-- Name: price_event_health; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.price_event_health AS
 SELECT article_id,
    source,
    ingested_at,
    price_state
   FROM public.listing_price_events;

--
-- Name: saved_searches; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.saved_searches AS
 SELECT search_key,
    name,
    url,
    category,
    last_scraped_at,
    listing_count,
    median_ppm2,
    new_count,
    drop_count
   FROM public.saved_searches;

--
-- Name: scrape_health; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.scrape_health AS
 SELECT id,
    search_key,
    started_at,
    finished_at,
    status,
    pages,
    cards,
    is_complete,
    failure_reason,
    truncation_reason,
    error
   FROM public.scrape_runs r;

-- Helpers whose return types are canonical reporting views above.
--
-- Name: listings_closed_filtered(text[], numeric, numeric, text[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.listings_closed_filtered(p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[]) RETURNS SETOF reporting.dashboard_listings
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT l.* FROM public.listings_closed_filtered(
    p_category, p_min_sqm, p_max_sqm, p_neighborhood) l
$$;
--
-- Name: listings_filtered(text[], numeric, numeric, text[], boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.listings_filtered(p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[], p_active_only boolean DEFAULT true) RETURNS SETOF reporting.dashboard_listings
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT l.* FROM public.listings_filtered(
    p_category, p_min_sqm, p_max_sqm, p_neighborhood, p_active_only) l
$$;

-- Name: overview_listings_filtered(text[], numeric, numeric, text[], text[], text[], boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.overview_listings_filtered(
    p_category text[], p_min_sqm numeric, p_max_sqm numeric,
    p_neighborhood text[], p_rooms text[], p_deal text[],
    p_active_only boolean DEFAULT true
) RETURNS SETOF reporting.dashboard_listings
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'reporting', 'olap', 'public', 'pg_temp'
    AS $$
  SELECT l.*
    FROM olap.listings l
    LEFT JOIN olap.current_listing_scores s USING (article_id)
   WHERE (NOT p_active_only OR
          (l.closed_at IS NULL AND l.last_seen > now() - interval '14 days'))
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (coalesce(cardinality(p_neighborhood), 0) = 0 OR
          coalesce(nullif(l.location, ''),
            CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
            = ANY (p_neighborhood))
     AND (coalesce(cardinality(p_rooms), 0) = 0 OR
          coalesce(s.room_bucket, reporting.room_bucket(l.rooms)) = ANY (p_rooms))
     AND (coalesce(cardinality(p_deal), 0) = 0 OR
          (CASE WHEN l.is_rent THEN 'rent' ELSE 'sale' END) = ANY (
            ARRAY(SELECT CASE WHEN selected = 'sell' THEN 'sale' ELSE selected END
                    FROM unnest(p_deal) AS d(selected))))
     AND (coalesce(cardinality(p_category), 0) = 0 OR
          l.closing_category = ANY (p_category) OR EXISTS (
            SELECT 1 FROM olap.listing_categories c
             WHERE c.article_id = l.article_id
               AND c.category = ANY (p_category)))
$$;



--
-- Name: resolved_price_evidence_for_articles(bigint[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.resolved_price_evidence_for_articles(p_article_ids bigint[]) RETURNS SETOF reporting.resolved_price_evidence
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $_$
  WITH picked AS (
    SELECT DISTINCT ON (p.article_id, p.effective_at)
           p.id, p.article_id, p.effective_at, p.ingested_at, p.price,
           p.price_state, p.source, p.provenance, p.observed_at,
           p.renewed_at, p.effective_at_basis
      FROM public.listing_price_events p
     WHERE p.article_id = ANY(COALESCE($1, '{}'::bigint[]))
       AND p.effective_at <= now()
     ORDER BY p.article_id, p.effective_at,
              CASE WHEN p.source IN ('search', 'detail') THEN 0 ELSE 1 END,
              CASE p.price_state
                WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                WHEN 'unpriced' THEN 2 ELSE 3 END,
              p.id DESC
  )
  SELECT p.id, p.article_id, p.effective_at, p.ingested_at, p.price,
         p.price_state, p.source, p.provenance, p.observed_at,
         p.renewed_at, p.effective_at_basis,
         reporting.comparison_currency(p.provenance ->> 'currency') AS currency_normalized,
         CASE
           WHEN p.provenance ? 'dealType' THEN
             CASE p.provenance ->> 'dealType'
               WHEN 'sale' THEN false WHEN 'rent' THEN true ELSE NULL::boolean
             END
           ELSE state.is_rent
         END AS evidence_is_rent
    FROM picked p
    LEFT JOIN LATERAL (
      SELECT h.is_rent
        FROM public.listing_state_history_state h
       WHERE h.article_id = p.article_id
         AND h.effective_at <= p.effective_at
         AND h.is_rent IS NOT NULL
       ORDER BY h.effective_at DESC, h.id DESC
       LIMIT 1
    ) state ON true
$_$;

-- Filter helper over the canonical price_changes view.
--
-- Name: price_changes_filtered(timestamp with time zone, timestamp with time zone, text[], numeric, numeric, text[], text[], text[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.price_changes_filtered(p_from timestamp with time zone, p_through timestamp with time zone, p_category text[] DEFAULT '{}'::text[], p_min_sqm numeric DEFAULT NULL::numeric, p_max_sqm numeric DEFAULT NULL::numeric, p_rooms text[] DEFAULT '{}'::text[], p_deal text[] DEFAULT '{}'::text[], p_neighborhood text[] DEFAULT '{}'::text[]) RETURNS SETOF reporting.price_changes
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT pc.* FROM public.price_changes_filtered(
    p_from, p_through, p_category, p_min_sqm, p_max_sqm,
    p_rooms, p_deal, p_neighborhood) pc
$$;
