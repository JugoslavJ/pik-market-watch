-- Preserve historical evidence, daily projections, and scrape-run history.
-- Raw response bodies and maintenance execution logs remain operational data
-- with their independent cleanup policies. Historical retention_days values
-- are inactive while action = 'retain'; partition routing remains enabled.

ALTER TABLE public.analytics_partition_policy
  DROP CONSTRAINT analytics_partition_policy_action_check;
ALTER TABLE public.analytics_partition_policy
  ADD CONSTRAINT analytics_partition_policy_action_check
  CHECK (action IN ('delete', 'archive', 'retain'));
ALTER TABLE public.analytics_partition_policy
  ALTER COLUMN action SET DEFAULT 'retain';

ALTER TABLE public.analytics_retention_policy
  DROP CONSTRAINT analytics_retention_policy_action_check;
ALTER TABLE public.analytics_retention_policy
  ADD CONSTRAINT analytics_retention_policy_action_check
  CHECK (action IN ('delete', 'archive', 'retain'));

UPDATE public.analytics_partition_policy SET action = 'retain';
UPDATE public.analytics_retention_policy SET action = 'retain'
 WHERE table_schema = 'public' AND table_name = 'scrape_runs';

CREATE OR REPLACE FUNCTION public.ensure_analytics_partitions(p_months_ahead integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE p record; v_min timestamptz; v_start date; v_stop date; v_cursor date;
        v_child text; v_lower text; v_upper text; v_created integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch analytics partitions', 0));
  FOR p IN SELECT * FROM public.analytics_partition_policy ORDER BY parent_schema, parent_table LOOP
    EXECUTE format('SELECT min(%I)::timestamptz FROM %I.%I', p.partition_column, p.parent_schema, p.parent_table) INTO v_min;
    v_start := date_trunc('month', COALESCE(v_min, now()))::date;
    IF p.action = 'delete' THEN
      v_start := GREATEST(v_start, date_trunc('month', now() - make_interval(days => p.retention_days))::date);
    END IF;
    v_stop := (date_trunc('month', now()) + make_interval(months => COALESCE(p_months_ahead, p.months_ahead) + 1))::date;
    v_cursor := v_start;
    WHILE v_cursor < v_stop LOOP
      v_child := p.parent_table || '_' || to_char(v_cursor, 'YYYY_MM');
      v_lower := CASE WHEN p.key_type = 'date'
        THEN format('%L::date', v_cursor)
        ELSE format('%L::timestamptz', v_cursor::timestamp AT TIME ZONE 'UTC') END;
      v_upper := CASE WHEN p.key_type = 'date'
        THEN format('%L::date', (v_cursor + interval '1 month')::date)
        ELSE format('%L::timestamptz', (v_cursor + interval '1 month')::timestamp AT TIME ZONE 'UTC') END;
      IF to_regclass(format('%I.%I', p.parent_schema, v_child)) IS NULL THEN
        EXECUTE format('CREATE TABLE %I.%I (CHECK (%I >= %s AND %I < %s)) INHERITS (%I.%I)',
          p.parent_schema, v_child, p.partition_column, v_lower, p.partition_column, v_upper,
          p.parent_schema, p.parent_table);
        EXECUTE format('CREATE INDEX %I ON %I.%I (%I)',
          v_child || '_key_idx', p.parent_schema, v_child, p.partition_column);
        IF p.parent_table IN ('listing_state_history', 'listing_price_events', 'price_history') THEN
          EXECUTE format('CREATE UNIQUE INDEX %I ON %I.%I (id)',
            v_child || '_id_uq', p.parent_schema, v_child);
          EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
            v_child || '_append_only', p.parent_schema, v_child);
          EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation()',
            v_child || '_append_only', p.parent_schema, v_child);
        ELSIF p.parent_table IN ('listing_daily', 'daily_listing_facts', 'public_daily_market') THEN
          EXECUTE format('CREATE UNIQUE INDEX %I ON %I.%I (day, article_id)',
            v_child || '_grain_uq', p.parent_schema, v_child);
        ELSIF p.parent_table = 'market_daily' THEN
          EXECUTE format('CREATE UNIQUE INDEX %I ON %I.%I (day)',
            v_child || '_grain_uq', p.parent_schema, v_child);
        END IF;
        v_created := v_created + 1;
      END IF;
      INSERT INTO public.analytics_partition_registry
        (parent_schema, parent_table, child_table, from_at, through_at)
      VALUES (p.parent_schema, p.parent_table, v_child, v_cursor::timestamp AT TIME ZONE 'UTC',
              (v_cursor + interval '1 month')::timestamp AT TIME ZONE 'UTC')
      ON CONFLICT (parent_schema, child_table) DO NOTHING;
      -- Move only rows still stored in the parent. Child rows are never copied
      -- twice when partition setup is retried.
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

CREATE OR REPLACE FUNCTION public.apply_history_retention(p_batch_size integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE p record; r record; v_cutoff timestamptz; v_deleted bigint := 0; v_n bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch history retention', 0));
  PERFORM set_config('app.history_maintenance', 'retention', true);
  FOR p IN SELECT * FROM public.analytics_partition_policy WHERE action = 'delete' ORDER BY parent_schema, parent_table LOOP
    v_cutoff := now() - make_interval(days => p.retention_days);
    FOR r IN SELECT child_table FROM public.analytics_partition_registry
      WHERE parent_schema = p.parent_schema AND parent_table = p.parent_table
        AND through_at <= v_cutoff ORDER BY through_at LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I.%I', p.parent_schema, r.child_table);
      DELETE FROM public.analytics_partition_registry
       WHERE parent_schema = p.parent_schema AND child_table = r.child_table;
    END LOOP;
    EXECUTE format('WITH doomed AS (SELECT ctid FROM ONLY %I.%I WHERE %I < $1 LIMIT $2)
                    DELETE FROM ONLY %I.%I t USING doomed d WHERE t.ctid = d.ctid',
      p.parent_schema, p.parent_table, p.partition_column,
      p.parent_schema, p.parent_table)
      USING v_cutoff, GREATEST(1, p_batch_size);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;
  FOR p IN SELECT * FROM public.analytics_retention_policy WHERE action = 'delete' ORDER BY table_schema, table_name LOOP
    v_cutoff := now() - make_interval(days => p.retention_days);
    EXECUTE format('WITH doomed AS (SELECT ctid FROM ONLY %I.%I WHERE %I < $1 LIMIT $2)
                    DELETE FROM ONLY %I.%I t USING doomed d WHERE t.ctid = d.ctid',
      p.table_schema, p.table_name, p.timestamp_column,
      p.table_schema, p.table_name)
      USING v_cutoff, GREATEST(1, p_batch_size);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;
  -- Raw bodies have a separate expiry contract and remain independent from
  -- the analytical history horizon.
  DELETE FROM public.raw_api_responses
   WHERE id IN (SELECT id FROM public.raw_api_responses WHERE expires_at <= now()
                ORDER BY expires_at, id LIMIT GREATEST(1, p_batch_size));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_deleted + v_n;
END
$$;

COMMENT ON FUNCTION public.apply_history_retention(integer) IS
  'Deletes only explicitly delete-enabled policy data and expired raw bodies; retained historical evidence, projections, and scrape runs are never age-pruned.';
