-- Avoid evaluating expensive OLTP source views when an incremental refresh has
-- no affected days or lifecycle articles.
DO $migration$
DECLARE
  v_definition text;
  v_old constant text := $old$
  DELETE FROM olap.daily_listing_facts d USING olap_dirty_days x WHERE d.day=x.day;
  INSERT INTO olap.daily_listing_facts
  SELECT s.* FROM reporting.daily_listing_facts_source s JOIN olap_dirty_days x USING(day);
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

  DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles x WHERE m.article_id=x.article_id;
  DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles x WHERE c.article_id=x.article_id;
  INSERT INTO olap.lifecycle_cycles
  SELECT s.* FROM reporting.lifecycle_cycles_source s JOIN olap_dirty_articles x USING(article_id);
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.lifecycle_movements
  SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s JOIN olap_dirty_articles x USING(article_id);
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
$old$;
  v_new constant text := $new$
  IF EXISTS (SELECT FROM olap_dirty_days) THEN
    DELETE FROM olap.daily_listing_facts d USING olap_dirty_days x WHERE d.day=x.day;
    INSERT INTO olap.daily_listing_facts
    SELECT s.* FROM reporting.daily_listing_facts_source s JOIN olap_dirty_days x USING(day);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  END IF;

  IF EXISTS (SELECT FROM olap_dirty_articles) THEN
    DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles x WHERE m.article_id=x.article_id;
    DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles x WHERE c.article_id=x.article_id;
    INSERT INTO olap.lifecycle_cycles
    SELECT s.* FROM reporting.lifecycle_cycles_source s JOIN olap_dirty_articles x USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    INSERT INTO olap.lifecycle_movements
    SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s JOIN olap_dirty_articles x USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  END IF;
$new$;
BEGIN
  SELECT pg_get_functiondef('reporting.refresh_dashboard_olap(boolean)'::regprocedure)
  INTO v_definition;

  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'refresh_dashboard_olap(boolean) does not match the expected definition';
  END IF;

  EXECUTE replace(v_definition, v_old, v_new);
END
$migration$;
