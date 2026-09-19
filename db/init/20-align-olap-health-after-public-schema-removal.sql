-- The retired dashboard_public schema is gone, but the existing refresh
-- function still records its internal compatibility marts as one grouped
-- OLAP generation. Keep that derived state consistent until those physical
-- compatibility tables are retired in a separate storage migration.

CREATE OR REPLACE VIEW reporting.olap_health AS
 SELECT max(refreshed_at) AS refreshed_at,
        min(refreshed_at) AS oldest_mart_at,
        (count(*))::integer AS tracked_marts,
        (count(DISTINCT refresh_id))::integer AS generation_count,
        ((count(DISTINCT refresh_id) = 1) AND (count(*) = 8)) AS generation_consistent,
        ((max(refreshed_at) >= (now() - '02:00:00'::interval))) AS refresh_is_fresh,
        (max(EXTRACT(epoch FROM (now() - refreshed_at))))::bigint AS maximum_age_seconds,
        (sum(row_count))::bigint AS tracked_rows
   FROM olap.refresh_state;

