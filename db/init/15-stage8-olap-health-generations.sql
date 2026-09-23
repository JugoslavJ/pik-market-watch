-- Keep the generation check aligned with the nine marts published by the
-- canonical dashboard refresh, including dashboard_filter_options.
CREATE OR REPLACE VIEW reporting.olap_health AS
 SELECT max(refreshed_at) AS refreshed_at,
    min(refreshed_at) AS oldest_mart_at,
    (count(*))::integer AS tracked_marts,
    (count(DISTINCT refresh_id))::integer AS generation_count,
    ((count(DISTINCT refresh_id) = 1) AND (count(*) = 9)) AS generation_consistent,
    (max(refreshed_at) >= (now() - '02:00:00'::interval)) AS refresh_is_fresh,
    (max(EXTRACT(epoch FROM (now() - refreshed_at))))::bigint AS maximum_age_seconds,
    (sum(row_count))::bigint AS tracked_rows
   FROM olap.refresh_state;
