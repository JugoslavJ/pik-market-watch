-- A daily rebuild can start before an OLAP publication and commit afterward.
-- Its transaction timestamp then predates the OLAP watermark. A bounded overlap
-- prevents that late commit from being skipped permanently.
DO $migration$
DECLARE
  v_definition text;
  v_old constant text := 'SELECT day FROM analytics_daily_coverage WHERE rebuilt_at > v_previous_at;';
  v_new constant text := $new$SELECT day FROM analytics_daily_coverage
   WHERE rebuilt_at > v_previous_at - interval '10 minutes';$new$;
BEGIN
  SELECT pg_get_functiondef('reporting.refresh_dashboard_olap(boolean)'::regprocedure)
  INTO v_definition;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'refresh_dashboard_olap(boolean) does not contain the expected coverage watermark';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;
