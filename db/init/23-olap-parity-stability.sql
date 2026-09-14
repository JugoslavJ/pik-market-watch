-- Exclude the intentionally clock-derived open-cycle age from parity. It can
-- cross a rounding boundary between the mart refresh and a later audit even
-- when every durable lifecycle field is identical.
CREATE OR REPLACE FUNCTION reporting.validate_dashboard_olap()
RETURNS TABLE(mart text, source_rows bigint, mart_rows bigint,
              missing_rows bigint, unexpected_rows bigint)
LANGUAGE sql STABLE SET jit=off AS $$
  SELECT 'daily_listing_facts',
    (SELECT count(*) FROM reporting.daily_listing_facts_source),
    (SELECT count(*) FROM olap.daily_listing_facts),
    (SELECT count(*) FROM (SELECT * FROM reporting.daily_listing_facts_source
                           EXCEPT ALL SELECT * FROM olap.daily_listing_facts) d),
    (SELECT count(*) FROM (SELECT * FROM olap.daily_listing_facts
                           EXCEPT ALL SELECT * FROM reporting.daily_listing_facts_source) d)
  UNION ALL
  SELECT 'lifecycle_cycles',
    (SELECT count(*) FROM reporting.lifecycle_cycles_source),
    (SELECT count(*) FROM olap.lifecycle_cycles),
    (SELECT count(*) FROM (
       SELECT to_jsonb(s)-'current_cycle_age_days' FROM reporting.lifecycle_cycles_source s
       EXCEPT ALL
       SELECT to_jsonb(m)-'current_cycle_age_days' FROM olap.lifecycle_cycles m) d),
    (SELECT count(*) FROM (
       SELECT to_jsonb(m)-'current_cycle_age_days' FROM olap.lifecycle_cycles m
       EXCEPT ALL
       SELECT to_jsonb(s)-'current_cycle_age_days' FROM reporting.lifecycle_cycles_source s) d)
  UNION ALL
  SELECT 'lifecycle_movements',
    (SELECT count(*) FROM reporting.lifecycle_movements_source),
    (SELECT count(*) FROM olap.lifecycle_movements),
    (SELECT count(*) FROM (SELECT * FROM reporting.lifecycle_movements_source
                           EXCEPT ALL SELECT * FROM olap.lifecycle_movements) d),
    (SELECT count(*) FROM (SELECT * FROM olap.lifecycle_movements
                           EXCEPT ALL SELECT * FROM reporting.lifecycle_movements_source) d)
$$;

COMMENT ON FUNCTION reporting.validate_dashboard_olap() IS
  'Expensive recovery audit: exact durable-field multiset parity; ignores only clock-derived open-cycle age.';
