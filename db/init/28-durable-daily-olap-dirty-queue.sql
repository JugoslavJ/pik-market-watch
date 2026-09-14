-- Durable commit-visible handoff from daily reconstruction to OLAP publication.
-- A generation token prevents a concurrent re-mark from being deleted by the
-- refresh that consumed an older version of the same day.
CREATE SEQUENCE IF NOT EXISTS analytics_daily_olap_dirty_generation_seq;

CREATE TABLE IF NOT EXISTS analytics_daily_olap_dirty (
  day date PRIMARY KEY,
  generation bigint NOT NULL
);

CREATE OR REPLACE FUNCTION mark_daily_olap_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.analytics_daily_olap_dirty(day, generation)
  VALUES (NEW.day, nextval('public.analytics_daily_olap_dirty_generation_seq'))
  ON CONFLICT (day) DO UPDATE SET generation = EXCLUDED.generation;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS analytics_daily_coverage_mark_olap_dirty
  ON analytics_daily_coverage;
CREATE TRIGGER analytics_daily_coverage_mark_olap_dirty
AFTER INSERT OR UPDATE ON analytics_daily_coverage
FOR EACH ROW EXECUTE FUNCTION mark_daily_olap_dirty();

-- Seed existing coverage once. The first incremental publication after this
-- migration intentionally reconciles all previously reconstructed days.
INSERT INTO analytics_daily_olap_dirty(day, generation)
SELECT day, nextval('analytics_daily_olap_dirty_generation_seq')
FROM analytics_daily_coverage
ON CONFLICT (day) DO UPDATE SET generation = EXCLUDED.generation;

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('reporting.refresh_dashboard_olap(boolean)'::regprocedure)
  INTO v_definition;

  v_old := $old$  IF p_force_full OR v_previous_at IS NULL THEN
    RETURN QUERY SELECT * FROM reporting.refresh_dashboard_olap_full();
    RETURN;
  END IF;$old$;
  v_new := $new$  IF p_force_full OR v_previous_at IS NULL THEN
    RETURN QUERY SELECT * FROM reporting.refresh_dashboard_olap_full();
    DELETE FROM analytics_daily_olap_dirty;
    RETURN;
  END IF;$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'refresh_dashboard_olap(boolean) full-refresh branch does not match';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$  CREATE TEMP TABLE olap_dirty_days(day date PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO olap_dirty_days
  SELECT day FROM analytics_daily_coverage
   WHERE rebuilt_at > v_previous_at - interval '10 minutes';$old$;
  v_new := $new$  CREATE TEMP TABLE olap_dirty_days(day date PRIMARY KEY, generation bigint NOT NULL) ON COMMIT DROP;
  INSERT INTO olap_dirty_days
  SELECT day, generation FROM analytics_daily_olap_dirty;$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'refresh_dashboard_olap(boolean) dirty-day selector does not match';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);

  v_old := $old$    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  END IF;

  IF EXISTS (SELECT FROM olap_dirty_articles) THEN$old$;
  v_new := $new$    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM analytics_daily_olap_dirty q USING olap_dirty_days x
     WHERE q.day=x.day AND q.generation=x.generation;
  END IF;

  IF EXISTS (SELECT FROM olap_dirty_articles) THEN$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'refresh_dashboard_olap(boolean) dirty-day publication block does not match';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;

COMMENT ON TABLE analytics_daily_olap_dirty IS
  'Commit-visible queue of reconstructed days awaiting OLAP publication.';
