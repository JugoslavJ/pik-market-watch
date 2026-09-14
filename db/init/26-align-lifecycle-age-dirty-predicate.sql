-- Match the canonical lifecycle source, which reports completed whole days.
DO $migration$
DECLARE
  v_definition text;
  v_old constant text := 'greatest(round(
          extract(epoch FROM (now()-opened_at))/86400.0)::int,0)';
  v_new constant text := 'greatest(floor(
          extract(epoch FROM (now()-opened_at))/86400.0)::int,0)';
BEGIN
  SELECT pg_get_functiondef('reporting.refresh_dashboard_olap(boolean)'::regprocedure)
  INTO v_definition;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'refresh_dashboard_olap(boolean) does not contain the expected age predicate';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;
