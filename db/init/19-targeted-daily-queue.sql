-- Keep routine search sightings as evidence without rebuilding unchanged rows.
-- Price changes, sparse/detail changes, lifecycle transitions, and new articles
-- still enter the daily projection queue.

CREATE OR REPLACE FUNCTION public.route_analytics_partition_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  p record;
  v_value text;
  v_suffix text;
  v_child text;
  v_reg regclass;
  v_json jsonb;
  v_article_id bigint;
  v_day date;
  v_mark boolean := false;
BEGIN
  SELECT * INTO p FROM public.analytics_partition_policy
   WHERE parent_schema = TG_TABLE_SCHEMA AND parent_table = TG_TABLE_NAME;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME IN ('listing_state_history', 'listing_price_events')
     AND to_jsonb(NEW)->>'article_id' IS NOT NULL THEN
    v_json := to_jsonb(NEW);
    v_article_id := (v_json->>'article_id')::bigint;

    IF TG_TABLE_NAME = 'listing_price_events'
       OR COALESCE(v_json->>'event_type', '') <> 'search_sighting' THEN
      v_mark := true;
    ELSE
      v_day := ((v_json->>'effective_at')::timestamptz
                AT TIME ZONE 'Europe/Sarajevo')::date;
      SELECT NOT EXISTS (
               SELECT 1
                 FROM public.listing_daily d
                WHERE d.day = v_day AND d.article_id = v_article_id
             )
          OR EXISTS (
               SELECT 1
                 FROM public.listing_daily d
                WHERE d.day = v_day AND d.article_id = v_article_id
                  AND (
                    (v_json->>'category' IS NOT NULL
                     AND d.category IS DISTINCT FROM v_json->>'category')
                    OR (v_json->>'is_rent' IS NOT NULL
                        AND d.is_rent IS DISTINCT FROM (v_json->>'is_rent')::boolean)
                    OR (v_json->>'sqm' IS NOT NULL
                        AND d.sqm IS DISTINCT FROM (v_json->>'sqm')::numeric)
                    OR (v_json->>'rooms' IS NOT NULL
                        AND d.rooms IS DISTINCT FROM v_json->>'rooms')
                    OR (COALESCE(v_json->'filter_attributes', '{}'::jsonb)
                          <> '{}'::jsonb
                        AND NOT (d.filter_attributes @>
                                 COALESCE(v_json->'filter_attributes', '{}'::jsonb)))
                    OR (COALESCE(v_json->'category_membership', '[]'::jsonb)
                          <> '[]'::jsonb
                        AND NOT (to_jsonb(d.category_memberships) @>
                                 COALESCE(v_json->'category_membership', '[]'::jsonb)))
                  )
             )
        INTO v_mark;
    END IF;

    IF v_mark THEN
      PERFORM public.mark_daily_article_dirty(v_article_id);
    END IF;
  END IF;

  v_value := to_jsonb(NEW)->>p.partition_column;
  IF v_value IS NULL THEN RETURN NEW; END IF;
  v_suffix := CASE WHEN p.key_type = 'date'
    THEN to_char(v_value::date, 'YYYY_MM')
    ELSE to_char((v_value::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY_MM') END;
  v_child := TG_TABLE_NAME || '_' || v_suffix;
  v_reg := to_regclass(format('%I.%I', TG_TABLE_SCHEMA, v_child));
  IF v_reg IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('INSERT INTO %I.%I SELECT ($1).*', TG_TABLE_SCHEMA, v_child)
    USING NEW;
  RETURN NULL;
END
$$;

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.rebuild_listing_daily_legacy(date,date)'::regprocedure
  ) INTO definition;

  IF position('candidate_grid' IN definition) > 0
     AND position('v_full_rebuild' IN definition) = 0 THEN
    definition := replace(
      definition,
      '  v_dirty_marked_at timestamptz := clock_timestamp();',
      $decl$
  v_dirty_marked_at timestamptz := clock_timestamp();
  v_full_rebuild boolean;
$decl$
    );

    definition := replace(
      definition,
      $begin$
BEGIN
  IF v_from IS NULL$begin$,
      $begin$
BEGIN
  SELECT (v_from < v_today AND NOT EXISTS (
           SELECT 1 FROM public.analytics_daily_dirty_articles
           WHERE article_id > 0
         ))
      OR EXISTS (
           SELECT 1 FROM public.analytics_daily_dirty_articles
           WHERE article_id = 0
         )
    INTO v_full_rebuild;

  IF v_from IS NULL$begin$
    );

    definition := replace(
      definition,
      $delete$
  IF EXISTS (SELECT 1 FROM public.analytics_daily_dirty_articles) THEN
    DELETE FROM listing_daily
     WHERE day BETWEEN v_from AND v_through
       AND article_id IN (SELECT article_id FROM public.analytics_daily_dirty_articles);
  ELSE
    DELETE FROM listing_daily WHERE day BETWEEN v_from AND v_through;
  END IF;
$delete$,
      $replacement$
  IF v_full_rebuild THEN
    DELETE FROM listing_daily WHERE day BETWEEN v_from AND v_through;
  ELSIF EXISTS (
    SELECT 1 FROM public.analytics_daily_dirty_articles WHERE article_id > 0
  ) THEN
    DELETE FROM listing_daily
     WHERE day BETWEEN v_from AND v_through
       AND article_id IN (
         SELECT article_id FROM public.analytics_daily_dirty_articles
          WHERE article_id > 0
       );
  ELSE
    RETURN QUERY SELECT v_from, v_through, 0::bigint;
    RETURN;
  END IF;
$replacement$
    );

    definition := replace(
      definition,
      '    SELECT article_id FROM public.analytics_daily_dirty_articles
  ),',
      '    SELECT article_id FROM public.analytics_daily_dirty_articles
     WHERE article_id > 0
  ),'
    );

    EXECUTE definition;
  END IF;
END
$$;

COMMENT ON FUNCTION public.route_analytics_partition_insert() IS
  'Routes analytics partitions and queues only daily-projection changes.';
