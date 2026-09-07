-- Disposable-snapshot-only prototype measurements for the daily storage gate.
-- This file is read-only. The typed and immutable-version designs must be
-- implemented in separate scratch schemas before any production migration.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';

SELECT 'current_daily' AS representation,
       pg_total_relation_size('listing_daily'::regclass) AS total_bytes,
       pg_table_size('listing_daily'::regclass) AS table_bytes,
       pg_indexes_size('listing_daily'::regclass) AS index_bytes,
       count(*) AS rows
  FROM listing_daily;

SELECT count(*) AS rows,
       count(DISTINCT filter_attributes) AS distinct_attributes,
       sum(pg_column_size(filter_attributes)) AS repeated_json_bytes,
       sum(pg_column_size(location)) AS location_bytes,
       sum(pg_column_size(neighborhood)) AS neighborhood_bytes
  FROM listing_daily;

SELECT 'gate' AS name,
       'Implement both scratch representations and compare exact row/value
        parity, complete allocation including indexes, rebuild time/WAL, and
        representative filtered percentile latency before adding migrations.'
         AS requirement;
COMMIT;
