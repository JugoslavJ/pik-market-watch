-- Canonical views baseline.
--
-- Name: daily_market; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.daily_market AS
 SELECT day,
    article_id,
    category_memberships,
    deal,
    sqm,
    rooms,
    price,
    price_state,
    ppm2,
    neighborhood,
    stale_observation,
    provisional_day,
    membership_inferred,
    attributes_inferred
   FROM olap.public_daily_market;

--
-- Name: exit_cycles; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.exit_cycles AS
 SELECT article_id,
    cycle_no,
    title,
    url,
    opened_at,
    closed_at,
    days_listed,
    category_memberships,
    category,
    deal,
    sqm,
    rooms,
    last_asking_price,
    last_asking_ppm2,
    reopened_cycle
   FROM olap.public_exit_cycles;

--
-- Name: freshness; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.freshness AS
 SELECT category,
    configured_searches,
    last_success_at
   FROM olap.public_freshness;

--
-- Name: price_reductions; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.price_reductions AS
 SELECT article_id,
    url,
    title,
    category_memberships,
    category,
    deal,
    sqm,
    rooms,
    neighborhood,
    prior_price,
    new_price,
    reduction_km,
    reduction_pct,
    event_at,
    currently_observed,
    last_seen
   FROM olap.public_price_reductions;

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
    reduction_pct
   FROM olap.current_listing_scores;

--
-- Name: VIEW current_listing_scores; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.current_listing_scores IS 'Stable Grafana contract backed only by the current market OLAP snapshot.';

--
-- Name: daily_listing_facts; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.daily_listing_facts AS
 SELECT day,
    article_id,
    title,
    url,
    category,
    category_memberships,
    is_rent,
    deal,
    rooms,
    sqm,
    location,
    neighborhood,
    price,
    price_state,
    ppm2,
    state_effective_at,
    price_effective_at,
    membership_inferred,
    attributes_inferred,
    stale_observation,
    provisional_day,
    filter_attributes,
    property_type,
    room_bucket,
    currency,
    historical_attributes,
    historical_seller_type,
    historical_condition,
    historical_furnished,
    historical_heating,
    historical_parking,
    historical_garage,
    historical_elevator,
    historical_floor_num,
    price_quality_reason,
    rate_quality_reason,
    price_eligible,
    rate_eligible,
    asking_price,
    asking_rate,
    asking_price_unit,
    asking_rate_unit
   FROM olap.daily_listing_facts;

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
    location,
    latitude,
    longitude,
    closed_at,
    closing_price,
    closing_ppm2,
    closing_category,
    published_at,
    renewed_at,
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
    api_price_history,
    api_status,
    details_fetched_at,
    last_enrichment_attempted_at,
    first_seen,
    last_seen
   FROM olap.listings;

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
-- Name: VIEW olap_health; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.olap_health IS 'Stable dashboard mart generation, age, and row-count monitoring contract.';

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
-- Name: VIEW olap_queue_health; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.olap_queue_health IS 'Pending daily-publication queue depth and age monitoring contract.';

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
