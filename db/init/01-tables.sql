-- Canonical tables baseline.
--
-- Name: listings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listings (
    article_id bigint NOT NULL,
    url text NOT NULL,
    title text NOT NULL,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    price_text text,
    ppm2 integer,
    is_rent boolean DEFAULT false NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    location text,
    latitude double precision,
    longitude double precision,
    closed_at timestamp with time zone,
    closing_price numeric(12,2),
    closing_ppm2 integer,
    published_at timestamp with time zone,
    closing_category text,
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
    details_fetched_at timestamp with time zone,
    api_price_history jsonb,
    api_status text,
    last_enrichment_attempted_at timestamp with time zone,
    renewed_at timestamp with time zone
);

--
-- Name: listing_price_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_price_events (
    id bigint NOT NULL,
    article_id bigint NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    price numeric(12,2),
    price_state text NOT NULL,
    source text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp with time zone,
    renewed_at timestamp with time zone,
    effective_at_basis text DEFAULT 'legacy'::text NOT NULL,
    currency text,
    CONSTRAINT listing_price_events_effective_at_basis_ck CHECK ((effective_at_basis = ANY (ARRAY['observed'::text, 'source_history'::text, 'legacy'::text]))),
    CONSTRAINT listing_price_events_price_state_check CHECK ((price_state = ANY (ARRAY['valid'::text, 'unpriced'::text, 'invalid'::text, 'conflict'::text]))),
    CONSTRAINT price_event_source_ck CHECK ((source = ANY (ARRAY['search'::text, 'detail'::text, 'api_price_history'::text, 'legacy_price_history'::text, 'legacy_api_price_history'::text, 'legacy_import'::text, 'benchmark'::text, 'fixture'::text]))),
    CONSTRAINT price_event_temporal_ck CHECK ((ingested_at >= effective_at)),
    CONSTRAINT price_event_value_ranges_ck CHECK (((price IS NULL) OR (price >= (0)::numeric)))
);

--
-- Name: COLUMN listing_price_events.effective_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_price_events.effective_at IS 'Source/evidence time used for temporal reconstruction. For current observations this is fetch time.';

--
-- Name: COLUMN listing_price_events.observed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_price_events.observed_at IS 'Database fetch/observation time for current evidence; NULL for source-history assertions.';

--
-- Name: COLUMN listing_price_events.renewed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_price_events.renewed_at IS 'Source renewal/bump timestamp, retained as metadata and never used as price effective time.';

--
-- Name: COLUMN listing_price_events.effective_at_basis; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_price_events.effective_at_basis IS 'How effective_at was established: observed, source_history, or legacy/unknown.';

--
-- Name: listing_state_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_state_history (
    id bigint NOT NULL,
    article_id bigint NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    run_id bigint,
    search_key text,
    price numeric(12,2),
    ppm2 integer,
    last_seen_at timestamp with time zone,
    closed_at timestamp with time zone,
    is_closed boolean DEFAULT false NOT NULL,
    state_version_id bigint NOT NULL,
    detail_version_id bigint,
    CONSTRAINT history_source_ck CHECK ((source = ANY (ARRAY['search'::text, 'detail'::text, 'lifecycle'::text, 'fixture'::text]))),
    CONSTRAINT history_temporal_ck CHECK (((ingested_at >= effective_at) OR (event_type = 'closed'::text))),
    CONSTRAINT listing_state_history_event_type_check CHECK ((event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'closed'::text, 'reopened'::text])))
);

--
-- Name: COLUMN listing_state_history.state_version_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_state_history.state_version_id IS 'Deduplicated state payload referenced by this historical observation.';

--
-- Name: listing_state_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_state_versions (
    state_version_id bigint NOT NULL,
    state_hash text NOT NULL,
    category text,
    category_membership text[] DEFAULT '{}'::text[] NOT NULL,
    is_rent boolean,
    sqm numeric(8,2),
    rooms text,
    filter_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    membership_inferred boolean DEFAULT false NOT NULL,
    attributes_inferred boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE listing_state_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_state_versions IS 'Content-addressed historical listing states shared by history and daily rows.';

--
-- Name: current_listing_scores; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.current_listing_scores (
    article_id bigint NOT NULL,
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
    benchmark_neighborhoods text[],
    CONSTRAINT olap_current_listing_scores_currency_ck CHECK (((currency IS NULL) OR (currency = 'KM'::text) OR (currency ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT olap_current_listing_scores_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
);

--
-- Name: TABLE current_listing_scores; Type: COMMENT; Schema: olap; Owner: -
--

COMMENT ON TABLE olap.current_listing_scores IS 'OLAP snapshot for private Grafana dashboards; rebuilt from OLTP listing and evidence tables.';

--
-- Name: comparison_price_changes; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.comparison_price_changes (
    article_id bigint NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    prior_effective_at timestamp with time zone,
    prior_price numeric,
    price numeric(12,2),
    delta numeric,
    pct_change numeric,
    deal text,
    currency text,
    CONSTRAINT olap_comparison_price_changes_currency_ck CHECK (((currency IS NULL) OR (currency = 'KM'::text) OR (currency ~ '^[A-Z]{3}$'::text)))
);

--
-- Name: daily_listing_facts; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.daily_listing_facts (
    day date NOT NULL,
    article_id bigint NOT NULL,
    price numeric(12,2),
    price_state text NOT NULL,
    ppm2 integer,
    state_effective_at timestamp with time zone,
    price_effective_at timestamp with time zone,
    property_type text,
    room_bucket text,
    currency text,
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
    asking_rate_unit text,
    deal text,
    neighborhood text,
    category text,
    category_memberships text[],
    rooms text,
    sqm numeric,
    location text,
    membership_inferred boolean NOT NULL DEFAULT false,
    attributes_inferred boolean NOT NULL DEFAULT false,
    stale_observation boolean NOT NULL DEFAULT false,
    provisional_day boolean NOT NULL DEFAULT false,
    CONSTRAINT olap_daily_listing_facts_currency_ck CHECK (((currency IS NULL) OR (currency = 'KM'::text) OR (currency ~ '^[A-Z]{3}$'::text)))
);

--
-- Name: lifecycle_cycles; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.lifecycle_cycles (
    article_id bigint NOT NULL,
    cycle_no bigint NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    opened_day date,
    closed_at timestamp with time zone,
    closed_day date,
    is_closed boolean NOT NULL,
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
    final_asking_rate_unit text,
    CONSTRAINT olap_lifecycle_cycles_closing_category_nonblank_ck CHECK (((closing_category IS NULL) OR (btrim(closing_category) <> ''::text))),
    CONSTRAINT olap_lifecycle_cycles_closing_currency_ck CHECK (((closing_currency IS NULL) OR (closing_currency = 'KM'::text) OR (closing_currency ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT olap_lifecycle_cycles_opening_category_nonblank_ck CHECK (((opening_category IS NULL) OR (btrim(opening_category) <> ''::text)))
);

--
-- Name: neighborhoods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neighborhoods (
    name text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    poly double precision[] NOT NULL,
    boundary public.geometry(MultiPolygon,4326),
    boundary_geography public.geography(MultiPolygon,4326),
    CONSTRAINT neighborhoods_boundary_valid CHECK (((public.st_srid(boundary) = 4326) AND (NOT public.st_isempty(boundary)) AND public.st_isvalid(boundary)))
);

--
-- Name: COLUMN neighborhoods.boundary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.neighborhoods.boundary IS 'Canonical PostGIS MultiPolygon boundary (WGS 84 / EPSG:4326); `poly` is retained temporarily for rollout comparison.';

--
-- Name: saved_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_searches (
    search_key text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    category text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_scraped_at timestamp with time zone,
    listing_count integer,
    median_ppm2 integer,
    new_count integer,
    drop_count integer,
    CONSTRAINT public_saved_searches_category_nonblank_ck CHECK (((category IS NULL) OR (btrim(category) <> ''::text)))
);

--
-- Name: search_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_results (
    search_key text NOT NULL,
    article_id bigint NOT NULL
);

--
-- Name: listings; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listings (
    article_id bigint NOT NULL,
    url text NOT NULL,
    title text NOT NULL,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    price_text text,
    ppm2 integer,
    is_rent boolean,
    first_seen timestamp with time zone NOT NULL,
    last_seen timestamp with time zone NOT NULL,
    location text,
    latitude double precision,
    longitude double precision,
    closed_at timestamp with time zone,
    closing_price numeric(12,2),
    closing_ppm2 integer,
    published_at timestamp with time zone,
    closing_category text,
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
    details_fetched_at timestamp with time zone,
    api_price_history jsonb,
    api_status text,
    last_enrichment_attempted_at timestamp with time zone,
    renewed_at timestamp with time zone
);

--
-- Name: listing_price_changes; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listing_price_changes (
    article_id bigint NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone,
    source text NOT NULL,
    price numeric(12,2),
    price_state text NOT NULL,
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
    null_boundary boolean,
    CONSTRAINT olap_listing_price_changes_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
);

--
-- Name: lifecycle_movements; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.lifecycle_movements (
    movement_type text NOT NULL,
    event_at timestamp with time zone NOT NULL,
    event_day date NOT NULL,
    article_id bigint NOT NULL,
    cycle_no bigint NOT NULL,
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
    historical_floor_num smallint,
    CONSTRAINT olap_lifecycle_movements_category_nonblank_ck CHECK (((category IS NULL) OR (btrim(category) <> ''::text))),
    CONSTRAINT olap_lifecycle_movements_currency_ck CHECK (((currency IS NULL) OR (currency = 'KM'::text) OR (currency ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT olap_lifecycle_movements_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
);

--
-- Name: listing_categories; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listing_categories (
    article_id bigint NOT NULL,
    category text NOT NULL,
    CONSTRAINT olap_listing_categories_category_nonblank_ck CHECK (((category IS NULL) OR (btrim(category) <> ''::text)))
);

-- Small indexed value sets used by Grafana dashboard variables.
CREATE TABLE olap.dashboard_filter_options (
    filter_name text NOT NULL,
    value text NOT NULL,
    sort_order integer,
    CONSTRAINT olap_dashboard_filter_options_pkey PRIMARY KEY (filter_name, value)
);

--
-- Name: listing_exit_economics; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.listing_exit_economics (
    article_id bigint NOT NULL,
    opening_price numeric(12,2),
    days_listed integer
);

--
-- Name: market_daily; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.market_daily (
    day date NOT NULL,
    new_n integer NOT NULL,
    closed_n integer NOT NULL,
    reopened_n integer NOT NULL,
    active_est integer NOT NULL,
    stale_n integer NOT NULL,
    provisional_day boolean DEFAULT false NOT NULL
);

--
-- Name: public_current_listings; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_current_listings (
    article_id bigint NOT NULL,
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
    views integer,
    CONSTRAINT olap_public_current_listings_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
);

--
-- Name: public_daily_market; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_daily_market (
    day date NOT NULL,
    article_id bigint NOT NULL,
    category_memberships text[],
    deal text,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    price_state text NOT NULL,
    ppm2 integer,
    neighborhood text,
    stale_observation boolean DEFAULT false NOT NULL,
    provisional_day boolean DEFAULT false NOT NULL,
    membership_inferred boolean DEFAULT false NOT NULL,
    attributes_inferred boolean DEFAULT false NOT NULL,
    CONSTRAINT olap_public_daily_market_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
);

--
-- Name: public_exit_cycles; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_exit_cycles (
    article_id bigint NOT NULL,
    cycle_no bigint NOT NULL,
    title text,
    url text,
    opened_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    days_listed integer,
    category_memberships text[],
    category text,
    deal text,
    sqm numeric(8,2),
    rooms text,
    last_asking_price numeric,
    last_asking_ppm2 integer,
    reopened_cycle boolean,
    CONSTRAINT olap_public_exit_cycles_category_nonblank_ck CHECK (((category IS NULL) OR (btrim(category) <> ''::text))),
    CONSTRAINT olap_public_exit_cycles_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
);

--
-- Name: public_freshness; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_freshness (
    category text NOT NULL,
    configured_searches integer NOT NULL,
    last_success_at timestamp with time zone
);

--
-- Name: public_price_reductions; Type: TABLE; Schema: olap; Owner: -
--

CREATE TABLE olap.public_price_reductions (
    article_id bigint NOT NULL,
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
    event_at timestamp with time zone NOT NULL,
    currently_observed boolean,
    last_seen timestamp with time zone,
    CONSTRAINT olap_public_price_reductions_category_nonblank_ck CHECK (((category IS NULL) OR (btrim(category) <> ''::text))),
    CONSTRAINT olap_public_price_reductions_deal_ck CHECK (((deal IS NULL) OR (deal = ANY (ARRAY['sale'::text, 'rent'::text, 'unknown'::text]))))
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

--
-- Name: analytics_contract_validation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_contract_validation (
    id bigint NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    ok boolean NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: analytics_contract_validation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_contract_validation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_contract_validation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: analytics_daily_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_daily_coverage (
    day date NOT NULL,
    rebuilt_at timestamp with time zone DEFAULT now() NOT NULL,
    provisional boolean DEFAULT false NOT NULL
);

--
-- Name: analytics_daily_dirty_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_daily_dirty_articles (
    article_id bigint NOT NULL,
    marked_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

--
-- Name: TABLE analytics_daily_dirty_articles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.analytics_daily_dirty_articles IS 'Article cohort whose daily projection must be replaced for the pending day range.';

--
-- Name: analytics_daily_olap_dirty; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_daily_olap_dirty (
    day date NOT NULL,
    generation bigint NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE analytics_daily_olap_dirty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.analytics_daily_olap_dirty IS 'Commit-visible queue of reconstructed days awaiting OLAP publication.';

--
-- Name: analytics_daily_olap_dirty_generation_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analytics_daily_olap_dirty_generation_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: analytics_partition_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_partition_policy (
    parent_schema text NOT NULL,
    parent_table text NOT NULL,
    partition_column text NOT NULL,
    key_type text NOT NULL,
    months_ahead smallint DEFAULT 2 NOT NULL,
    CONSTRAINT analytics_partition_policy_key_type_check CHECK ((key_type = ANY (ARRAY['date'::text, 'timestamptz'::text]))),
    CONSTRAINT analytics_partition_policy_months_ahead_check CHECK ((months_ahead >= 0))
);

--
-- Name: analytics_partition_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_partition_registry (
    parent_schema text NOT NULL,
    parent_table text NOT NULL,
    child_table text NOT NULL,
    from_at timestamp with time zone NOT NULL,
    through_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analytics_partition_registry_check CHECK ((from_at < through_at))
);

--
-- Name: analytics_refresh_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_refresh_state (
    scope text NOT NULL,
    pending_from_day date,
    pending_through_day date,
    last_successful_refresh_at timestamp with time zone,
    historical_tracking_boundary timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_through_day date,
    CONSTRAINT analytics_refresh_state_range_ck CHECK (((pending_from_day IS NULL) OR (pending_through_day IS NULL) OR (pending_from_day <= pending_through_day)))
);

--
-- Name: COLUMN analytics_refresh_state.completed_through_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.analytics_refresh_state.completed_through_day IS 'Latest contiguous Sarajevo day whose daily projection was successfully rebuilt and finalized.';

--
-- Name: analytics_retention_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_retention_policy (
    table_schema text NOT NULL,
    table_name text NOT NULL,
    timestamp_column text NOT NULL,
    retention_days integer NOT NULL,
    action text DEFAULT 'delete'::text NOT NULL,
    CONSTRAINT analytics_retention_policy_action_check CHECK ((action = ANY (ARRAY['delete'::text, 'archive'::text, 'retain'::text]))),
    CONSTRAINT analytics_retention_policy_retention_days_check CHECK ((retention_days > 0))
);

--
-- Name: detail_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.detail_jobs (
    article_id bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    last_attempted_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_outcome text,
    last_error text,
    last_http_status integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT detail_jobs_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT detail_jobs_completed_ck CHECK (((status <> ALL (ARRAY['succeeded'::text, 'terminal'::text])) OR (completed_at IS NOT NULL))),
    CONSTRAINT detail_jobs_last_outcome_check CHECK (((last_outcome IS NULL) OR (last_outcome = ANY (ARRAY['success'::text, 'retryable_failure'::text, 'terminal_failure'::text, 'not_found'::text, 'cancelled'::text])))),
    CONSTRAINT detail_jobs_lease_ck CHECK (((status <> 'leased'::text) OR (lease_until IS NOT NULL))),
    CONSTRAINT detail_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'succeeded'::text, 'terminal'::text])))
);

--
-- Name: TABLE detail_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.detail_jobs IS 'Durable detail request queue with claim leases, retry schedule, and outcome telemetry';

--
-- Name: COLUMN detail_jobs.next_attempt_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.detail_jobs.next_attempt_at IS 'Earliest timestamp at which a pending or expired lease may be claimed';

--
-- Name: COLUMN detail_jobs.lease_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.detail_jobs.lease_until IS 'Claim expiry; an expired lease is safe to reclaim by another scraper process';

--
-- Name: listing_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_daily (
    day date NOT NULL,
    article_id bigint NOT NULL,
    price numeric(12,2),
    price_state text DEFAULT 'unknown'::text NOT NULL,
    ppm2 integer,
    location text,
    state_effective_at timestamp with time zone,
    price_effective_at timestamp with time zone,
    stale_observation boolean DEFAULT false NOT NULL,
    provisional_day boolean DEFAULT false NOT NULL,
    neighborhood text,
    resolved_state_version smallint DEFAULT 0 NOT NULL,
    state_version_id bigint NOT NULL,
    detail_version_id bigint,
    CONSTRAINT listing_daily_price_state_check CHECK ((price_state = ANY (ARRAY['valid'::text, 'unpriced'::text, 'invalid'::text, 'unknown'::text, 'conflict'::text])))
);

--
-- Name: COLUMN listing_daily.resolved_state_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_daily.resolved_state_version IS '0: direct insert requiring compatibility resolution; 1: bulk-resolved state and geography';

--
-- Name: COLUMN listing_daily.state_version_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_daily.state_version_id IS 'Deduplicated resolved state payload referenced by this listing-day row.';

--
-- Name: listing_detail_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_detail_versions (
    detail_version_id bigint NOT NULL,
    article_id bigint NOT NULL,
    detail_hash text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    url text NOT NULL,
    title text NOT NULL,
    sqm numeric(8,2),
    rooms text,
    is_rent boolean NOT NULL,
    location text,
    latitude double precision,
    longitude double precision,
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
    characteristics jsonb DEFAULT '{}'::jsonb NOT NULL,
    api_status text,
    api_price_history jsonb,
    CONSTRAINT listing_detail_versions_interval_ck CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);

--
-- Name: TABLE listing_detail_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.listing_detail_versions IS 'Slowly changing listing details; one row is created only when detail content changes.';

--
-- Name: listing_detail_versions_detail_version_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.listing_detail_versions ALTER COLUMN detail_version_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.listing_detail_versions_detail_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: listing_price_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.listing_price_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.listing_price_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: listing_publication_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_publication_evidence (
    id bigint NOT NULL,
    article_id bigint NOT NULL,
    published_at timestamp with time zone NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    evidence_kind text DEFAULT 'upstream_created_at'::text NOT NULL
);

--
-- Name: listing_publication_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.listing_publication_evidence ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.listing_publication_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: listing_state_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.listing_state_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.listing_state_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: listing_state_versions_state_version_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.listing_state_versions ALTER COLUMN state_version_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.listing_state_versions_state_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: maintenance_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_runs (
    id bigint NOT NULL,
    run_type text NOT NULL,
    outcome text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    rows_affected bigint DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT maintenance_runs_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'error'::text]))),
    CONSTRAINT maintenance_runs_rows_affected_check CHECK ((rows_affected >= 0))
);

--
-- Name: TABLE maintenance_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.maintenance_runs IS 'Bounded operational outcomes and durations for retention and analytics maintenance.';

--
-- Name: maintenance_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.maintenance_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.maintenance_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: olap_article_dirty; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.olap_article_dirty (
    article_id bigint NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_history (
    id bigint NOT NULL,
    article_id bigint NOT NULL,
    scraped_at timestamp with time zone DEFAULT now() NOT NULL,
    price numeric(12,2),
    ppm2 integer
);

--
-- Name: price_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.price_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.price_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: publication_evidence_transition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publication_evidence_transition (
    id smallint NOT NULL,
    last_raw_id bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recoverable bigint DEFAULT 0 NOT NULL,
    imported bigint DEFAULT 0 NOT NULL,
    conflicting bigint DEFAULT 0 NOT NULL,
    unrecoverable bigint DEFAULT 0 NOT NULL,
    CONSTRAINT publication_evidence_transition_id_check CHECK ((id = 1))
);

--
-- Name: raw_api_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_api_responses (
    id bigint NOT NULL,
    run_id bigint,
    article_id bigint,
    request_kind text NOT NULL,
    request_url text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT 'infinity'::timestamp with time zone NOT NULL,
    parser_version text NOT NULL,
    payload jsonb,
    source_payload jsonb,
    request_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    build_version text DEFAULT 'unknown'::text NOT NULL,
    diagnostic jsonb,
    archive_format text DEFAULT 'legacy-v1'::text NOT NULL,
    CONSTRAINT raw_api_responses_archive_format_ck CHECK ((archive_format = ANY (ARRAY['legacy-v1'::text, 'canonical-v2'::text, 'diagnostic-v2'::text]))),
    CONSTRAINT raw_api_responses_request_kind_check CHECK ((request_kind = ANY (ARRAY['search'::text, 'detail'::text])))
);

--
-- Name: COLUMN raw_api_responses.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.expires_at IS 'Compatibility timestamp; count-based maintenance retains the newest configured number per request kind and URL.';

--
-- Name: COLUMN raw_api_responses.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.payload IS 'Backward-compatible adapter payload (items/meta for search, decoded detail for detail).';

--
-- Name: COLUMN raw_api_responses.source_payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.source_payload IS 'Original decoded upstream JSON body, retained for parser replay while unexpired.';

--
-- Name: COLUMN raw_api_responses.request_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.request_metadata IS 'Bounded, non-secret request metadata such as method and URL.';

--
-- Name: COLUMN raw_api_responses.response_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.response_metadata IS 'Bounded response metadata such as status, content type, byte count, and attempts.';

--
-- Name: COLUMN raw_api_responses.build_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.build_version IS 'Parser/build identifier that produced this archive record.';

--
-- Name: COLUMN raw_api_responses.diagnostic; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.diagnostic IS 'Bounded error or parser diagnostic; NULL for successful responses.';

--
-- Name: COLUMN raw_api_responses.archive_format; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_api_responses.archive_format IS 'legacy-v1 uses source_payload/payload fallback; canonical-v2 has one original body; diagnostic-v2 has no successful body.';

--
-- Name: raw_api_responses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.raw_api_responses ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.raw_api_responses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: raw_retention_transition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_retention_transition (
    id smallint NOT NULL,
    horizon_days smallint NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rows_capped bigint DEFAULT 0 NOT NULL,
    CONSTRAINT raw_retention_transition_horizon_days_check CHECK ((horizon_days > 0)),
    CONSTRAINT raw_retention_transition_id_check CHECK ((id = 1)),
    CONSTRAINT raw_retention_transition_rows_capped_check CHECK ((rows_capped >= 0))
);

--
-- Name: TABLE raw_retention_transition; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.raw_retention_transition IS 'Durable progress marker for the bounded cap of legacy raw expiry timestamps.';

--
-- Name: scrape_run_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scrape_run_pages (
    run_id bigint NOT NULL,
    page_number integer NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    request_url text NOT NULL,
    response_state text NOT NULL,
    expected_total integer,
    expected_last_page integer,
    response_page integer,
    response_per_page integer,
    raw_item_count integer DEFAULT 0 NOT NULL,
    parsed_item_count integer DEFAULT 0 NOT NULL,
    duplicate_item_count integer DEFAULT 0 NOT NULL,
    parse_rejection_count integer DEFAULT 0 NOT NULL,
    parse_rejections jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    is_authoritative boolean DEFAULT false NOT NULL,
    CONSTRAINT scrape_run_pages_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT scrape_run_pages_duplicate_item_count_check CHECK ((duplicate_item_count >= 0)),
    CONSTRAINT scrape_run_pages_expected_last_page_check CHECK (((expected_last_page IS NULL) OR (expected_last_page > 0))),
    CONSTRAINT scrape_run_pages_expected_total_check CHECK (((expected_total IS NULL) OR (expected_total >= 0))),
    CONSTRAINT scrape_run_pages_page_number_check CHECK ((page_number > 0)),
    CONSTRAINT scrape_run_pages_parse_rejection_count_check CHECK ((parse_rejection_count >= 0)),
    CONSTRAINT scrape_run_pages_parsed_item_count_check CHECK ((parsed_item_count >= 0)),
    CONSTRAINT scrape_run_pages_raw_item_count_check CHECK ((raw_item_count >= 0)),
    CONSTRAINT scrape_run_pages_response_page_check CHECK (((response_page IS NULL) OR (response_page > 0))),
    CONSTRAINT scrape_run_pages_response_per_page_check CHECK (((response_per_page IS NULL) OR (response_per_page > 0))),
    CONSTRAINT scrape_run_pages_response_state_check CHECK ((response_state = ANY (ARRAY['ok'::text, 'verified_empty'::text, 'malformed'::text, 'blocked'::text, 'error'::text])))
);

--
-- Name: TABLE scrape_run_pages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.scrape_run_pages IS 'Per-page scrape attempts, parser diagnostics, and authority classification.';

--
-- Name: COLUMN scrape_run_pages.is_authoritative; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scrape_run_pages.is_authoritative IS 'True only when this page response is safe to use as complete pagination evidence.';

--
-- Name: scrape_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scrape_runs (
    id bigint NOT NULL,
    search_key text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    pages integer,
    cards integer,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    is_complete boolean DEFAULT false NOT NULL,
    failure_reason text,
    truncation_reason text,
    CONSTRAINT scrape_runs_completion_ck CHECK ((((status = 'running'::text) AND (finished_at IS NULL) AND (NOT is_complete)) OR ((status <> 'running'::text) AND (finished_at IS NOT NULL)))),
    CONSTRAINT scrape_runs_status_ck CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text]))),
    CONSTRAINT scrape_runs_temporal_ck CHECK (((finished_at IS NULL) OR (finished_at >= started_at)))
);

--
-- Name: scrape_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.scrape_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.scrape_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: current_market_refresh_state; Type: TABLE; Schema: reporting; Owner: -
--

CREATE TABLE reporting.current_market_refresh_state (
    singleton boolean DEFAULT true NOT NULL,
    refreshed_at timestamp with time zone,
    row_count integer DEFAULT 0 NOT NULL,
    refresh_duration_ms integer,
    source_max_last_seen timestamp with time zone,
    CONSTRAINT current_market_refresh_state_singleton_check CHECK (singleton)
);
