-- Remove redundant indexes introduced by the original OLAP/index baseline.
-- Constraint-backed indexes remain the uniqueness enforcement surface.

DROP INDEX IF EXISTS olap.comparison_price_changes_article_time_idx;
DROP INDEX IF EXISTS olap.current_listing_scores_olap_article_idx;
DROP INDEX IF EXISTS olap.daily_listing_facts_grain_idx;
DROP INDEX IF EXISTS olap.lifecycle_cycles_grain_idx;
DROP INDEX IF EXISTS olap.lifecycle_movements_grain_idx;
DROP INDEX IF EXISTS olap.listing_exit_economics_article_idx;
DROP INDEX IF EXISTS olap.listings_article_idx;
DROP INDEX IF EXISTS olap.market_daily_day_idx;

-- market_daily child grain indexes already begin with day, so the extra
-- child-local day-only indexes add write amplification without a distinct
-- access path.  Drop only the exact generated names, not arbitrary indexes.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS index_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'olap'
       AND c.relkind = 'i'
       AND c.relname ~ '^market_daily_[0-9]{4}_[0-9]{2}_key_idx$'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.schema_name, r.index_name);
  END LOOP;
END $$;

-- Keep future partition creation from recreating market_daily_*_key_idx.
CREATE OR REPLACE FUNCTION public.ensure_analytics_partitions(p_months_ahead integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  p record;
  r record;
  v_min timestamptz;
  v_start date;
  v_stop date;
  v_cursor date;
  v_child text;
  v_lower text;
  v_upper text;
  v_created integer := 0;
  v_table regclass;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch analytics partitions', 0));

  FOR p IN
    SELECT * FROM public.analytics_partition_policy
     ORDER BY parent_schema, parent_table
  LOOP
    EXECUTE format('SELECT min(%I)::timestamptz FROM %I.%I',
      p.partition_column, p.parent_schema, p.parent_table) INTO v_min;
    v_start := date_trunc('month', COALESCE(v_min, now()))::date;
    v_stop := (date_trunc('month', now()) +
      make_interval(months => COALESCE(p_months_ahead, p.months_ahead) + 1))::date;
    v_cursor := v_start;

    WHILE v_cursor < v_stop LOOP
      v_child := p.parent_table || '_' || to_char(v_cursor, 'YYYY_MM');
      v_lower := CASE WHEN p.key_type = 'date'
        THEN format('%L::date', v_cursor)
        ELSE format('%L::timestamptz', v_cursor::timestamp AT TIME ZONE 'UTC') END;
      v_upper := CASE WHEN p.key_type = 'date'
        THEN format('%L::date', (v_cursor + interval '1 month')::date)
        ELSE format('%L::timestamptz', (v_cursor + interval '1 month')::timestamp AT TIME ZONE 'UTC') END;

      v_table := to_regclass(format('%I.%I', p.parent_schema, v_child));
      IF v_table IS NULL THEN
        EXECUTE format(
          'CREATE TABLE %I.%I (CHECK (%I >= %s AND %I < %s)) INHERITS (%I.%I)',
          p.parent_schema, v_child, p.partition_column, v_lower,
          p.partition_column, v_upper, p.parent_schema, p.parent_table);
        v_created := v_created + 1;
      END IF;

      -- market_daily's child grain index already covers day.  The other
      -- inheritance children retain their existing narrow routing index.
      IF p.parent_table <> 'market_daily' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (%I)',
          v_child || '_key_idx', p.parent_schema, v_child, p.partition_column);
      END IF;

      IF p.parent_table = 'listing_state_history' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, effective_at DESC, id DESC)',
          v_child || '_article_effective_idx', p.parent_schema, v_child);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I USING brin (ingested_at)',
          v_child || '_ingested_brin', p.parent_schema, v_child);
      ELSIF p.parent_table = 'listing_price_events' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, effective_at, id)',
          v_child || '_article_effective_idx', p.parent_schema, v_child);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, ingested_at DESC) WHERE source <> ''detail''',
          v_child || '_article_ingested_non_detail_idx', p.parent_schema, v_child);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I USING brin (ingested_at)',
          v_child || '_ingested_brin', p.parent_schema, v_child);
      ELSIF p.parent_table = 'price_history' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, scraped_at DESC)',
          v_child || '_article_scraped_idx', p.parent_schema, v_child);
      ELSIF p.parent_table = 'listing_daily' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, day DESC)',
          v_child || '_article_day_idx', p.parent_schema, v_child);
      ELSIF p.parent_schema = 'olap' AND p.parent_table = 'daily_listing_facts' THEN
        IF EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = v_table
             AND a.attname IN ('deal', 'neighborhood')
             AND a.attnum > 0
             AND NOT a.attisdropped
           GROUP BY a.attrelid
          HAVING count(*) = 2
        ) THEN
          EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (deal, property_type, neighborhood, room_bucket, day)',
            v_child || '_cohort_day_idx', p.parent_schema, v_child);
        END IF;
      END IF;

      IF p.parent_table IN ('listing_state_history', 'listing_price_events', 'price_history') THEN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (id)',
          v_child || '_id_uq', p.parent_schema, v_child);
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
          v_child || '_append_only', p.parent_schema, v_child);
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation()',
          v_child || '_append_only', p.parent_schema, v_child);
      ELSIF p.parent_table IN ('listing_daily', 'daily_listing_facts', 'public_daily_market') THEN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (day, article_id)',
          v_child || '_grain_uq', p.parent_schema, v_child);
      ELSIF p.parent_table = 'market_daily' THEN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (day)',
          v_child || '_grain_uq', p.parent_schema, v_child);
      END IF;

      INSERT INTO public.analytics_partition_registry
        (parent_schema, parent_table, child_table, from_at, through_at)
      VALUES (
        p.parent_schema, p.parent_table, v_child,
        v_cursor::timestamp AT TIME ZONE 'UTC',
        (v_cursor + interval '1 month')::timestamp AT TIME ZONE 'UTC')
      ON CONFLICT (parent_schema, child_table) DO NOTHING;

      EXECUTE format('INSERT INTO %I.%I SELECT * FROM ONLY %I.%I WHERE %I >= %s AND %I < %s',
        p.parent_schema, v_child, p.parent_schema, p.parent_table,
        p.partition_column, v_lower, p.partition_column, v_upper);
      PERFORM set_config('app.history_maintenance', 'migration', true);
      EXECUTE format('DELETE FROM ONLY %I.%I WHERE %I >= %s AND %I < %s',
        p.parent_schema, p.parent_table, p.partition_column, v_lower,
        p.partition_column, v_upper);
      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
      p.parent_table || '_partition_route', p.parent_schema, p.parent_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert()',
      p.parent_table || '_partition_route', p.parent_schema, p.parent_table);
  END LOOP;
  RETURN v_created;
END
$$;

SELECT public.ensure_analytics_partitions();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'olap'
       AND c.relkind = 'i'
       AND c.relname ~ '^market_daily_[0-9]{4}_[0-9]{2}_key_idx$'
  ) THEN
    RAISE EXCEPTION 'market_daily child key indexes remain after dedup migration';
  END IF;
END $$;
