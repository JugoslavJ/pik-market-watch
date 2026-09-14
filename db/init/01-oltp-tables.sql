-- Canonical oltp tables baseline.
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
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL
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
    CONSTRAINT listing_price_events_effective_at_basis_ck CHECK ((effective_at_basis = ANY (ARRAY['observed'::text, 'source_history'::text, 'legacy'::text]))),
    CONSTRAINT listing_price_events_price_state_check CHECK ((price_state = ANY (ARRAY['valid'::text, 'unpriced'::text, 'invalid'::text, 'conflict'::text])))
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
    category text,
    category_membership text[] DEFAULT '{}'::text[] NOT NULL,
    is_rent boolean,
    sqm numeric(8,2),
    rooms text,
    price numeric(12,2),
    ppm2 integer,
    filter_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_seen_at timestamp with time zone,
    closed_at timestamp with time zone,
    is_closed boolean DEFAULT false NOT NULL,
    membership_inferred boolean DEFAULT false NOT NULL,
    attributes_inferred boolean DEFAULT false NOT NULL,
    CONSTRAINT listing_state_history_event_type_check CHECK ((event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'closed'::text, 'reopened'::text])))
);

--
-- Name: neighborhoods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neighborhoods (
    name text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    poly double precision[] NOT NULL
);

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
    drop_count integer
);

--
-- Name: search_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_results (
    search_key text NOT NULL,
    article_id bigint NOT NULL
);

--
-- Name: listing_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.listing_daily (
    day date NOT NULL,
    article_id bigint NOT NULL,
    price numeric(12,2),
    price_state text DEFAULT 'unknown'::text NOT NULL,
    ppm2 integer,
    is_rent boolean,
    sqm numeric(8,2),
    rooms text,
    category text,
    location text,
    state_effective_at timestamp with time zone,
    price_effective_at timestamp with time zone,
    membership_inferred boolean DEFAULT false NOT NULL,
    attributes_inferred boolean DEFAULT false NOT NULL,
    stale_observation boolean DEFAULT false NOT NULL,
    provisional_day boolean DEFAULT false NOT NULL,
    category_memberships text[] DEFAULT '{}'::text[] NOT NULL,
    filter_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    neighborhood text,
    resolved_state_version smallint DEFAULT 0 NOT NULL,
    CONSTRAINT listing_daily_price_state_check CHECK ((price_state = ANY (ARRAY['valid'::text, 'unpriced'::text, 'invalid'::text, 'unknown'::text, 'conflict'::text])))
);

--
-- Name: COLUMN listing_daily.resolved_state_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.listing_daily.resolved_state_version IS '0: direct insert requiring compatibility resolution; 1: bulk-resolved state and geography';

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
    truncation_reason text
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
    expires_at timestamp with time zone DEFAULT (now() + '3 days'::interval) NOT NULL,
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
