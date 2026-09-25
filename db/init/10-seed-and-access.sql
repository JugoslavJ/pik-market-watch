-- Seed rows and reporting access.

-- Initial singleton and maintenance-control rows.

INSERT INTO public.analytics_refresh_state (scope) VALUES ('listing_daily') ON CONFLICT DO NOTHING;
INSERT INTO public.raw_retention_transition (id, horizon_days) VALUES (1, 3) ON CONFLICT DO NOTHING;
INSERT INTO public.publication_evidence_transition (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO reporting.current_market_refresh_state (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- Canonical routing metadata. These rows are part of the working schema state,
-- not optional application data: the history/event triggers use them to route
-- writes and mark the affected daily-rebuild cohort.
INSERT INTO public.analytics_partition_policy
  (parent_schema, parent_table, partition_column, key_type, months_ahead)
VALUES
  ('public', 'listing_state_history', 'effective_at', 'timestamptz', 2),
  ('public', 'listing_price_events', 'effective_at', 'timestamptz', 2),
  ('public', 'price_history', 'scraped_at', 'timestamptz', 2),
  ('public', 'listing_daily', 'day', 'date', 2),
  ('olap', 'daily_listing_facts', 'day', 'date', 2),
  ('olap', 'market_daily', 'day', 'date', 2)
ON CONFLICT (parent_schema, parent_table) DO UPDATE SET
  partition_column = EXCLUDED.partition_column,
  key_type = EXCLUDED.key_type,
  months_ahead = EXCLUDED.months_ahead;

INSERT INTO public.analytics_retention_policy
  (table_schema, table_name, timestamp_column, retention_days, action)
VALUES
  ('public', 'maintenance_runs', 'finished_at', 90, 'delete')
ON CONFLICT (table_schema, table_name) DO UPDATE SET
  timestamp_column = EXCLUDED.timestamp_column,
  retention_days = EXCLUDED.retention_days,
  action = EXCLUDED.action;

-- Stable reporting routine access for the read-only parent role.

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting
  GRANT EXECUTE ON FUNCTIONS TO pg_read_all_data;
