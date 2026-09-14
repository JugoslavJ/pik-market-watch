-- Canonical olap tables baseline.
--
-- Name: public_current_listings; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_current_listings (
    article_id bigint,
    url text,
    title text,
    category_memberships text[],
    deal text,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    ppm2 integer,
    neighborhood text,
    latitude double precision,
    longitude double precision,
    published_at timestamp with time zone,
    first_seen timestamp with time zone,
    renewed_at timestamp with time zone,
    last_seen timestamp with time zone,
    views integer
);

--
-- Name: public_daily_market; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_daily_market (
    day date,
    article_id bigint,
    category_memberships text[],
    deal text,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    price_state text,
    ppm2 integer,
    neighborhood text,
    stale_observation boolean,
    provisional_day boolean,
    membership_inferred boolean,
    attributes_inferred boolean
);

--
-- Name: public_exit_cycles; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_exit_cycles (
    article_id bigint,
    cycle_no bigint,
    title text,
    url text,
    opened_at timestamp with time zone,
    closed_at timestamp with time zone,
    days_listed integer,
    category_memberships text[],
    category text,
    deal text,
    sqm numeric(8,2),
    rooms text,
    last_asking_price numeric,
    last_asking_ppm2 integer,
    reopened_cycle boolean
);

--
-- Name: public_freshness; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_freshness (
    category text,
    configured_searches integer,
    last_success_at timestamp with time zone
);

--
-- Name: public_price_reductions; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_price_reductions (
    article_id bigint,
    url text,
    title text,
    category_memberships text[],
    category text,
    deal text,
    sqm numeric(8,2),
    rooms text,
    neighborhood text,
    prior_price numeric,
    new_price numeric(12,2),
    reduction_km numeric,
    reduction_pct numeric,
    event_at timestamp with time zone,
    currently_observed boolean,
    last_seen timestamp with time zone
);

--
-- Name: comparison_price_changes; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.comparison_price_changes (
    article_id bigint,
    effective_at timestamp with time zone,
    prior_effective_at timestamp with time zone,
    prior_price numeric,
    price numeric(12,2),
    delta numeric,
    pct_change numeric,
    deal text,
    currency text
);

--
-- Name: current_listing_scores; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.current_listing_scores (
    article_id bigint,
    url text,
    title text,
    sqm numeric(8,2),
    rooms text,
    is_rent boolean,
    deal text,
    latitude double precision,
    longitude double precision,
    first_seen timestamp with time zone,
    last_seen timestamp with time zone,
    seller_type text,
    condition text,
    parking boolean,
    garage boolean,
    elevator boolean,
    heating text,
    floor_num smallint,
    plot_sqm numeric(8,2),
    year_built smallint,
    bathrooms smallint,
    rooms_detail text,
    furnished boolean,
    category_memberships text[],
    property_type text,
    neighborhood text,
    room_bucket text,
    resolved_price numeric(12,2),
    price_state text,
    currency text,
    price_effective_at timestamp with time zone,
    evidence_is_rent boolean,
    cycle_opened_at timestamp with time zone,
    current_cycle_age_days integer,
    reopened boolean,
    benchmark_at timestamp with time zone,
    score_version integer,
    price_reason text,
    asking_price numeric,
    asking_rate numeric,
    score_input_reason text,
    comparable_count integer,
    benchmark_rate numeric,
    benchmark_p25 numeric,
    benchmark_p75 numeric,
    deviation_pct numeric,
    unscored_reason text,
    confidence text,
    score integer,
    position_label text,
    indicative_total numeric,
    indicative_low numeric,
    indicative_high numeric,
    asking_gap_km numeric,
    latest_reduction_at timestamp with time zone,
    reduction_km numeric,
    reduction_pct numeric,
    local_comparable_count integer,
    benchmark_scope text,
    benchmark_neighborhoods text[]
);

--
-- Name: TABLE current_listing_scores; Type: COMMENT; Schema: olap; Owner: -
--

COMMENT ON TABLE olap.current_listing_scores IS 'OLAP snapshot for private Grafana dashboards; rebuilt from OLTP listing and evidence tables.';

--
-- Name: daily_listing_facts; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.daily_listing_facts (
    day date,
    article_id bigint,
    title text,
    url text,
    category text,
    category_memberships text[],
    is_rent boolean,
    deal text,
    rooms text,
    sqm numeric(8,2),
    location text,
    neighborhood text,
    price numeric(12,2),
    price_state text,
    ppm2 integer,
    state_effective_at timestamp with time zone,
    price_effective_at timestamp with time zone,
    membership_inferred boolean,
    attributes_inferred boolean,
    stale_observation boolean,
    provisional_day boolean,
    filter_attributes jsonb,
    property_type text,
    room_bucket text,
    currency text,
    historical_attributes jsonb,
    historical_seller_type text,
    historical_condition text,
    historical_furnished boolean,
    historical_heating text,
    historical_parking boolean,
    historical_garage boolean,
    historical_elevator boolean,
    historical_floor_num smallint,
    price_quality_reason text,
    rate_quality_reason text,
    price_eligible boolean,
    rate_eligible boolean,
    asking_price numeric,
    asking_rate numeric,
    asking_price_unit text,
    asking_rate_unit text
);

--
-- Name: lifecycle_cycles; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.lifecycle_cycles (
    article_id bigint,
    cycle_no bigint,
    opened_at timestamp with time zone,
    opened_day date,
    closed_at timestamp with time zone,
    closed_day date,
    is_closed boolean,
    reopened_cycle boolean,
    observed_cycle_duration_days integer,
    current_cycle_age_days integer,
    opening_category text,
    opening_category_memberships text[],
    opening_deal text,
    opening_property_type text,
    opening_sqm numeric,
    opening_rooms text,
    opening_room_bucket text,
    opening_neighborhood text,
    opening_attributes jsonb,
    opening_membership_inferred boolean,
    opening_attributes_inferred boolean,
    closing_category text,
    closing_category_memberships text[],
    closing_deal text,
    closing_property_type text,
    closing_sqm numeric,
    closing_rooms text,
    closing_room_bucket text,
    closing_neighborhood text,
    closing_attributes jsonb,
    closing_membership_inferred boolean,
    closing_attributes_inferred boolean,
    closing_price_effective_at timestamp with time zone,
    closing_price_state text,
    closing_currency text,
    closing_observed_price numeric(12,2),
    closing_price_quality_reason text,
    closing_rate_quality_reason text,
    closing_price_eligible boolean,
    closing_rate_eligible boolean,
    final_asking_price numeric,
    final_asking_rate numeric,
    final_asking_price_unit text,
    final_asking_rate_unit text
);

--
-- Name: lifecycle_movements; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.lifecycle_movements (
    movement_type text,
    event_at timestamp with time zone,
    event_day date,
    article_id bigint,
    cycle_no bigint,
    reopened_cycle boolean,
    deal text,
    property_type text,
    category text,
    category_memberships text[],
    sqm numeric,
    rooms text,
    room_bucket text,
    neighborhood text,
    historical_attributes jsonb,
    membership_inferred boolean,
    attributes_inferred boolean,
    price_state text,
    currency text,
    asking_price numeric,
    asking_rate numeric,
    price_eligible boolean,
    rate_eligible boolean,
    historical_seller_type text,
    historical_condition text,
    historical_furnished boolean,
    historical_heating text,
    historical_parking boolean,
    historical_garage boolean,
    historical_elevator boolean,
    historical_floor_num smallint
);

--
-- Name: listing_categories; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listing_categories (
    article_id bigint,
    category text
);

--
-- Name: listing_exit_economics; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listing_exit_economics (
    article_id bigint,
    opening_price numeric(12,2),
    days_listed integer
);

--
-- Name: listing_price_changes; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listing_price_changes (
    article_id bigint,
    effective_at timestamp with time zone,
    ingested_at timestamp with time zone,
    source text,
    price numeric(12,2),
    price_state text,
    deal text,
    prior_price numeric,
    delta numeric,
    pct_change numeric,
    prior_effective_at timestamp with time zone,
    current_effective_at timestamp with time zone,
    category text,
    category_memberships text[],
    sqm numeric(8,2),
    rooms text,
    provenance jsonb,
    null_boundary boolean
);

--
-- Name: listings; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listings (
    article_id bigint,
    url text,
    title text,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    price_text text,
    ppm2 integer,
    is_rent boolean,
    location text,
    latitude double precision,
    longitude double precision,
    closed_at timestamp with time zone,
    closing_price numeric(12,2),
    closing_ppm2 integer,
    closing_category text,
    published_at timestamp with time zone,
    renewed_at timestamp with time zone,
    seller_type text,
    rooms_detail text,
    bathrooms smallint,
    floor_num smallint,
    floors_total smallint,
    unit_levels smallint,
    heating text,
    furnished boolean,
    condition text,
    parking boolean,
    garage boolean,
    elevator boolean,
    year_built smallint,
    plot_sqm numeric(8,2),
    orientation text,
    views integer,
    favorites integer,
    characteristics jsonb,
    api_price_history jsonb,
    api_status text,
    details_fetched_at timestamp with time zone,
    last_enrichment_attempted_at timestamp with time zone,
    first_seen timestamp with time zone,
    last_seen timestamp with time zone
);

--
-- Name: market_daily; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.market_daily (
    day date,
    new_n integer,
    closed_n integer,
    reopened_n integer,
    active_est integer,
    stale_n integer,
    provisional_day boolean
);

--
-- Name: refresh_id_seq; Type: SEQUENCE; Schema: olap; Owner: -
--

CREATE SEQUENCE olap.refresh_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: refresh_state; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.refresh_state (
    mart text NOT NULL,
    refreshed_at timestamp with time zone NOT NULL,
    row_count bigint NOT NULL,
    source_watermark timestamp with time zone,
    refresh_id bigint NOT NULL,
    CONSTRAINT refresh_state_row_count_check CHECK ((row_count >= 0))
);
