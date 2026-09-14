-- Open cycles are not inherently dirty on every hourly maintenance run. Their
-- only clock-derived field changes when rounded observed age crosses a day
-- boundary; evidence changes are already selected by ingestion timestamps.
-- Patch the migration-22 function in place so this remains a small, explicit
-- forward migration instead of duplicating its full publication body.
DO $replace_open_cycle_dirty_set$
DECLARE
  v_definition text;
  v_old constant text :=
    'UNION SELECT article_id FROM olap.lifecycle_cycles WHERE NOT is_closed';
  v_new constant text :=
    'UNION SELECT article_id FROM olap.lifecycle_cycles
      WHERE NOT is_closed
        AND current_cycle_age_days IS DISTINCT FROM greatest(round(
          extract(epoch FROM (now()-opened_at))/86400.0)::int,0)';
BEGIN
  SELECT pg_get_functiondef(
    'reporting.refresh_dashboard_olap(boolean)'::regprocedure
  ) INTO v_definition;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'incremental OLAP function does not contain the expected open-cycle dirty selector';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$replace_open_cycle_dirty_set$;

COMMENT ON FUNCTION reporting.refresh_dashboard_olap(boolean) IS
  'Incrementally publishes dirty daily/lifecycle grains; open cycles refresh only when rounded age changes; true forces a full rebuild.';
