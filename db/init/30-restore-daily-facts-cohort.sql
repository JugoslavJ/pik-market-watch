-- Phase 1: keep the compact OLAP fact narrow, but retain the hot dashboard
-- cohort keys.  Title and URL remain current-listing identity and are joined
-- at the reporting boundary.

ALTER TABLE olap.daily_listing_facts
  ADD COLUMN IF NOT EXISTS deal text,
  ADD COLUMN IF NOT EXISTS neighborhood text;

-- The pre-27 source view is the canonical historical reconstruction.  Use it
-- to fill the two narrow columns without rebuilding listing_daily or any
-- append-only history table.
DO $$
BEGIN
  IF to_regclass('reporting.daily_listing_facts_source_state_legacy') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE olap.daily_listing_facts f
         SET deal = s.deal,
             neighborhood = s.neighborhood
        FROM reporting.daily_listing_facts_source_state_legacy s
       WHERE s.day = f.day
         AND s.article_id = f.article_id
         AND (f.deal IS DISTINCT FROM s.deal
              OR f.neighborhood IS DISTINCT FROM s.neighborhood)
    $sql$;
  END IF;
END
$$;

-- Keep the compact source row contract positional for the existing INSERT
-- SELECT refresh functions.  The two restored keys are appended because
-- PostgreSQL ALTER TABLE adds them after the original compact columns.
DROP VIEW IF EXISTS reporting.daily_listing_facts_source;
CREATE VIEW reporting.daily_listing_facts_source AS
SELECT s.day,
       s.article_id,
       s.price,
       s.price_state,
       s.ppm2,
       s.state_effective_at,
       s.price_effective_at,
       s.property_type,
       s.room_bucket,
       s.currency,
       s.historical_seller_type,
       s.historical_condition,
       s.historical_furnished,
       s.historical_heating,
       s.historical_parking,
       s.historical_garage,
       s.historical_elevator,
       s.historical_floor_num,
       s.price_quality_reason,
       s.rate_quality_reason,
       s.price_eligible,
       s.rate_eligible,
       s.asking_price,
       s.asking_rate,
       s.asking_price_unit,
       s.asking_rate_unit,
       s.deal,
       s.neighborhood
  FROM reporting.daily_listing_facts_source_state_legacy s;

CREATE OR REPLACE FUNCTION reporting.daily_listing_facts_source_for_days(
  p_days date[]
) RETURNS SETOF olap.daily_listing_facts
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT s.*
    FROM reporting.daily_listing_facts_source s
   WHERE s.day = ANY (p_days)
$$;

-- Restore the stable reporting contract, using the fact's narrow cohort keys
-- for the predicates that previously became expensive joins after migration
-- 27. The remaining state columns continue to come from canonical daily
-- state, preserving historical semantics.
DROP VIEW IF EXISTS reporting.daily_listing_facts;
CREATE VIEW reporting.daily_listing_facts AS
SELECT d.day,
       d.article_id,
       l.title,
       l.url,
       d.category,
       d.category_memberships,
       d.is_rent,
       f.deal,
       d.rooms,
       d.sqm,
       d.location,
       f.neighborhood,
       f.price,
       f.price_state,
       f.ppm2,
       f.state_effective_at,
       f.price_effective_at,
       d.membership_inferred,
       d.attributes_inferred,
       d.stale_observation,
       d.provisional_day,
       d.filter_attributes,
       f.property_type,
       f.room_bucket,
       f.currency,
       d.filter_attributes AS historical_attributes,
       f.historical_seller_type,
       f.historical_condition,
       f.historical_furnished,
       f.historical_heating,
       f.historical_parking,
       f.historical_garage,
       f.historical_elevator,
       f.historical_floor_num,
       f.price_quality_reason,
       f.rate_quality_reason,
       f.price_eligible,
       f.rate_eligible,
       f.asking_price,
       f.asking_rate,
       f.asking_price_unit,
       f.asking_rate_unit
  FROM olap.daily_listing_facts f
  LEFT JOIN public.listing_daily_state d
    ON d.day = f.day AND d.article_id = f.article_id
  LEFT JOIN public.listings l
    ON l.article_id = f.article_id;

-- Full helper definition: new children receive the cohort index at creation;
-- existing children are deliberately left for the non-transactional
-- reindex-dashboard-facts command, which uses CREATE INDEX CONCURRENTLY.
CREATE OR REPLACE FUNCTION public.ensure_analytics_partitions(p_months_ahead integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  p record;
  v_min timestamptz;
  v_start date;
  v_stop date;
  v_cursor date;
  v_child text;
  v_lower text;
  v_upper text;
  v_table regclass;
  v_new boolean;
  v_created integer := 0;
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
      v_new := v_table IS NULL;

      IF v_new THEN
        EXECUTE format(
          'CREATE TABLE %I.%I (CHECK (%I >= %s AND %I < %s)) INHERITS (%I.%I)',
          p.parent_schema, v_child, p.partition_column, v_lower,
          p.partition_column, v_upper, p.parent_schema, p.parent_table);
        v_table := to_regclass(format('%I.%I', p.parent_schema, v_child));
        v_created := v_created + 1;
      END IF;

      IF v_new AND p.parent_table <> 'market_daily' THEN
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
      ELSIF v_new AND p.parent_schema = 'olap'
            AND p.parent_table = 'daily_listing_facts' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I
                        (deal, property_type, neighborhood, room_bucket, day)',
          v_child || '_cohort_day_idx', p.parent_schema, v_child);
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
      VALUES (p.parent_schema, p.parent_table, v_child,
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

COMMENT ON FUNCTION public.ensure_analytics_partitions(integer) IS
  'Creates analytics children and cohort indexes for new daily-fact children; existing cohort indexes are rebuilt concurrently by maintenance.';
