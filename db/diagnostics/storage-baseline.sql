-- Read-only storage/maintenance baseline. Run against a disposable restore or
-- a live database with an appropriate statement_timeout. Never include payloads
-- or credentials in the captured report.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT now() AS measured_at,
       current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       pg_database_size(current_database()) AS database_bytes;

SELECT current_setting('server_version_num') AS schema_probe,
       to_jsonb(s) AS refresh_state,
       w.from_day, w.through_day, w.reason
  FROM analytics_refresh_state s
  CROSS JOIN LATERAL analytics_daily_rebuild_window() w
 WHERE s.scope = 'listing_daily';

SELECT relname,
       n_live_tup AS estimated_live_rows,
       n_dead_tup AS estimated_dead_rows,
       pg_total_relation_size(relid) AS total_bytes,
       pg_table_size(relid) AS table_and_toast_bytes,
       pg_indexes_size(relid) AS index_bytes,
       last_autovacuum, last_autoanalyze
  FROM pg_stat_user_tables
 ORDER BY total_bytes DESC;

SELECT request_kind,
       count(*) AS rows,
       count(*) FILTER (WHERE expires_at <= now()) AS expired,
       count(*) FILTER (WHERE expires_at > fetched_at + INTERVAL '3 days')
         AS over_horizon,
       count(*) FILTER (WHERE payload IS NOT DISTINCT FROM source_payload
                         AND payload IS NOT NULL) AS proven_duplicate_bodies,
       min(fetched_at) AS oldest_fetch,
       max(fetched_at) AS newest_fetch
  FROM raw_api_responses
 GROUP BY request_kind
 ORDER BY request_kind;

SELECT * FROM raw_retention_transition;

SELECT date_trunc('day', ingested_at) AS ingestion_day,
       count(*) AS state_events,
       count(DISTINCT article_id) AS articles
  FROM listing_state_history
 GROUP BY 1 ORDER BY 1;

SELECT run_type, outcome, started_at, finished_at,
       extract(epoch FROM (finished_at - started_at)) AS duration_seconds,
       rows_affected, details
  FROM maintenance_runs
 ORDER BY finished_at DESC
 LIMIT 100;

SELECT count(*) AS daily_rows,
       min(day) AS first_day,
       max(day) AS last_day,
       count(DISTINCT filter_attributes) AS distinct_attribute_values,
       sum(pg_column_size(filter_attributes)) AS attribute_value_bytes,
       count(*) FILTER (WHERE location IS NOT DISTINCT FROM neighborhood)
         AS equal_location_columns
  FROM listing_daily;

COMMIT;
