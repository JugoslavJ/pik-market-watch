-- Canonical reporting state baseline.
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
