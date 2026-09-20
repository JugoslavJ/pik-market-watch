-- Bounded maintenance publication and interval-based daily reconstruction.
--
-- Normal ingestion changes a small article cohort. Keep that cohort durable so
-- the daily rebuild can replace only affected grains, and derive candidate
-- article/day rows from activity/price intervals instead of a full Cartesian
-- product. A full rebuild remains available when the queue is empty.

CREATE TABLE IF NOT EXISTS public.analytics_daily_dirty_articles (
  article_id bigint PRIMARY KEY,
  marked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS analytics_daily_dirty_articles_marked_idx
  ON public.analytics_daily_dirty_articles (marked_at);

CREATE OR REPLACE FUNCTION public.mark_daily_article_dirty(p_article_id bigint)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.analytics_daily_dirty_articles(article_id, marked_at)
  VALUES ($1, clock_timestamp())
  ON CONFLICT (article_id) DO UPDATE SET marked_at = EXCLUDED.marked_at;
$$;

-- The parent partition router is the one write path for history/event inserts.
-- Mark before routing so child partitions do not need a trigger per month.
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
BEGIN
  SELECT * INTO p FROM public.analytics_partition_policy
   WHERE parent_schema = TG_TABLE_SCHEMA AND parent_table = TG_TABLE_NAME;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME IN ('listing_state_history', 'listing_price_events')
     AND to_jsonb(NEW)->>'article_id' IS NOT NULL THEN
    PERFORM public.mark_daily_article_dirty((to_jsonb(NEW)->>'article_id')::bigint);
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

  -- Docker-style initialization may have already executed this file before
  -- the application migrator records it. Leave the installed function alone
  -- on that second pass.
  IF position('candidate_grid' IN definition) = 0 THEN
  -- Keep the existing state/price resolution contract, but feed it an
  -- interval-derived candidate grid. The old grid cross joined every history
  -- article to every requested day before filtering inactive rows.
  definition := regexp_replace(
    definition,
    $pattern$(?s)  articles AS \(.*?  facts AS MATERIALIZED \($pattern$,
    $replacement$
  dirty_articles AS (
    SELECT article_id FROM public.analytics_daily_dirty_articles
  ),
  activity_windows AS (
    SELECT h.article_id,
           h.effective_at,
           COALESCE(h.last_seen_at, h.effective_at) + interval '14 days' AS through_at
      FROM public.listing_state_history h
     WHERE h.event_type IN ('search_sighting', 'reopened')
       AND (NOT EXISTS (SELECT 1 FROM dirty_articles)
            OR EXISTS (SELECT 1 FROM dirty_articles d WHERE d.article_id = h.article_id))
  ),
  price_windows AS (
    SELECT e.article_id, min(e.effective_at) AS from_at
      FROM public.listing_price_events e
     WHERE e.price_state = 'valid'
       AND e.price IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM dirty_articles)
            OR EXISTS (SELECT 1 FROM dirty_articles d WHERE d.article_id = e.article_id))
     GROUP BY e.article_id
  ),
  candidate_grid AS (
    SELECT DISTINCT w.article_id, d.day, d.endpoint
      FROM activity_windows w
      JOIN days d ON d.endpoint > w.effective_at
                AND d.endpoint <= w.through_at
    UNION
    SELECT DISTINCT w.article_id, d.day, d.endpoint
      FROM price_windows w
      JOIN days d ON d.endpoint > w.from_at
  ),
  grid AS (
    SELECT article_id, day, endpoint FROM candidate_grid
  ),
  facts AS MATERIALIZED (
$replacement$,
    1,
    0,
    'n'
  );

  -- Replace the range delete with a cohort delete when the queue is populated.
  -- Empty queue means an explicit/full rebuild and retains the old behavior.
  definition := replace(
    definition,
    '  DELETE FROM listing_daily WHERE day BETWEEN v_from AND v_through;',
    $delete$
  IF EXISTS (SELECT 1 FROM public.analytics_daily_dirty_articles) THEN
    DELETE FROM listing_daily
     WHERE day BETWEEN v_from AND v_through
       AND article_id IN (SELECT article_id FROM public.analytics_daily_dirty_articles);
  ELSE
    DELETE FROM listing_daily WHERE day BETWEEN v_from AND v_through;
  END IF;
$delete$
  );

  -- Do not lose a new mark that arrived while this rebuild was running. The
  -- rebuild function's declaration gets a transaction-start marker.
  definition := replace(
    definition,
    '  v_rows BIGINT;',
    $decl$
  v_rows BIGINT;
  v_dirty_marked_at timestamptz := clock_timestamp();
$decl$
  );
  definition := replace(
    definition,
    '  RETURN QUERY SELECT v_from, v_through, v_rows;',
    $clear$
  IF v_pending_from IS NULL
     OR (v_from <= v_pending_from AND v_through >= COALESCE(v_pending_through, v_through)) THEN
    DELETE FROM public.analytics_daily_dirty_articles
     WHERE marked_at <= v_dirty_marked_at;
  END IF;

  RETURN QUERY SELECT v_from, v_through, v_rows;
$clear$
  );

    EXECUTE definition;
  END IF;
END
$$;

COMMENT ON TABLE public.analytics_daily_dirty_articles IS
  'Article cohort whose daily projection must be replaced for the pending day range.';
