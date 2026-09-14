-- Initial singleton/control rows.

INSERT INTO public.analytics_refresh_state (scope) VALUES ('listing_daily') ON CONFLICT DO NOTHING;
INSERT INTO public.raw_retention_transition (id, horizon_days) VALUES (1, 3) ON CONFLICT DO NOTHING;
INSERT INTO public.publication_evidence_transition (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO reporting.current_market_refresh_state (singleton) VALUES (true) ON CONFLICT DO NOTHING;
