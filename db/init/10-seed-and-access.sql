-- Seed rows and reporting access.

-- Initial singleton and maintenance-control rows.

INSERT INTO public.analytics_refresh_state (scope) VALUES ('listing_daily') ON CONFLICT DO NOTHING;
INSERT INTO public.raw_retention_transition (id, horizon_days) VALUES (1, 3) ON CONFLICT DO NOTHING;
INSERT INTO public.publication_evidence_transition (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO reporting.current_market_refresh_state (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- Stable reporting routine access for the read-only parent role.

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting
  GRANT EXECUTE ON FUNCTIONS TO pg_read_all_data;
