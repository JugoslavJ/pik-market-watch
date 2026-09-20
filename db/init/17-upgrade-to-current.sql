-- Compatibility bridge for volumes created before the final split baseline.
-- Fresh installs already contain these definitions in 00-16; every statement
-- remains idempotent so an existing volume can cross the boundary safely.

-- >>> 17-history-retention.sql
-- Remove age-based retention from analytical history.
--
-- Partition policy is routing metadata only. Historical evidence, daily
-- projections, OLAP marts, and scrape runs have no age horizon and cannot be
-- deleted by the maintenance function. Operational cleanup policies remain
-- available for maintenance-run telemetry and expired raw response bodies.

ALTER TABLE public.analytics_partition_policy
  DROP CONSTRAINT IF EXISTS analytics_partition_policy_action_check;
ALTER TABLE public.analytics_partition_policy
  DROP COLUMN IF EXISTS retention_days,
  DROP COLUMN IF EXISTS action;

DELETE FROM public.analytics_retention_policy
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

CREATE OR REPLACE FUNCTION public.apply_operational_cleanup(p_batch_size integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE p record; v_cutoff timestamptz; v_deleted bigint := 0; v_n bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch operational cleanup', 0));
  PERFORM set_config('app.history_maintenance', 'cleanup', true);
  FOR p IN SELECT * FROM public.analytics_retention_policy WHERE action = 'delete'
           ORDER BY table_schema, table_name LOOP
    v_cutoff := now() - make_interval(days => p.retention_days);
    EXECUTE format('WITH doomed AS (SELECT ctid FROM ONLY %I.%I WHERE %I < $1 LIMIT $2)
                    DELETE FROM ONLY %I.%I t USING doomed d WHERE t.ctid = d.ctid',
      p.table_schema, p.table_name, p.timestamp_column,
      p.table_schema, p.table_name)
      USING v_cutoff, GREATEST(1, p_batch_size);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;
  DELETE FROM public.raw_api_responses
   WHERE id IN (SELECT id FROM public.raw_api_responses WHERE expires_at <= now()
                ORDER BY expires_at, id LIMIT GREATEST(1, p_batch_size));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_deleted + v_n;
END
$$;

-- Keep the old entry point for scripts and third-party operators, but make it
-- an operational-cleanup alias so no caller can age-prune historical data.
CREATE OR REPLACE FUNCTION public.apply_history_retention(p_batch_size integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  RETURN public.apply_operational_cleanup(p_batch_size);
END
$$;

COMMENT ON FUNCTION public.apply_operational_cleanup(integer) IS
  'Cleans only explicitly delete-enabled operational policy data and expired raw bodies; analytical history is never age-pruned.';
COMMENT ON FUNCTION public.apply_history_retention(integer) IS
  'Compatibility alias for apply_operational_cleanup; no analytical history is deleted.';

-- Raw response retention is count-based rather than time-based. Keep the
-- expiry column for compatibility with existing tooling and legacy rows, but
-- make new and existing records effectively non-expiring; maintenance removes
-- records beyond the configured per-stream count.
UPDATE public.raw_api_responses
   SET expires_at = 'infinity'::timestamptz
 WHERE expires_at IS DISTINCT FROM 'infinity'::timestamptz;

ALTER TABLE public.raw_api_responses
  ALTER COLUMN expires_at SET DEFAULT 'infinity'::timestamptz;

COMMENT ON COLUMN public.raw_api_responses.expires_at IS
  'Compatibility timestamp; count-based maintenance retains the newest configured number per request kind and URL.';

-- <<< 17-history-retention.sql

-- >>> 18-dashboard-reporting-access.sql
-- Complete the dashboard contract for the restricted Grafana login.
-- Keep operational tables private and expose only the fields used by health
-- panels/alerts. Existing market views continue to read the published marts.
CREATE OR REPLACE VIEW reporting.saved_searches AS
SELECT search_key, name, url, category, last_scraped_at,
       listing_count, median_ppm2, new_count, drop_count
FROM public.saved_searches;

CREATE OR REPLACE VIEW reporting.listing_health AS
SELECT article_id, closed_at, last_seen, latitude, longitude, sqm, price,
       ppm2, is_rent, api_status, details_fetched_at, last_enrichment_attempted_at
FROM public.listings;

CREATE OR REPLACE VIEW reporting.price_event_health AS
SELECT article_id, source, ingested_at, price_state
FROM public.listing_price_events;

CREATE OR REPLACE VIEW reporting.analytics_refresh_state AS
SELECT scope, pending_from_day, pending_through_day, completed_through_day,
       last_successful_refresh_at, updated_at
FROM public.analytics_refresh_state;

-- These read-only wrappers execute as the migration owner. The login needs
-- no public/olap table or function privileges. Pin the search path, including
-- pg_temp last, because the older helper bodies contain unqualified names.
CREATE OR REPLACE FUNCTION reporting.dashboard_numeric(p_value text)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.dashboard_numeric(p_value) $$;

CREATE OR REPLACE FUNCTION reporting.room_bucket(rooms text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.room_bucket(rooms) $$;

CREATE OR REPLACE FUNCTION reporting.listings_filtered(
  p_category text[], p_min_sqm numeric, p_max_sqm numeric,
  p_neighborhood text[], p_active_only boolean DEFAULT true
) RETURNS SETOF reporting.dashboard_listings
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT l.* FROM public.listings_filtered(
    p_category, p_min_sqm, p_max_sqm, p_neighborhood, p_active_only) l
$$;

CREATE OR REPLACE FUNCTION reporting.listings_closed_filtered(
  p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[]
) RETURNS SETOF reporting.dashboard_listings
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT l.* FROM public.listings_closed_filtered(
    p_category, p_min_sqm, p_max_sqm, p_neighborhood) l
$$;

CREATE OR REPLACE FUNCTION reporting.price_changes_filtered(
  p_from timestamptz, p_through timestamptz,
  p_category text[] DEFAULT '{}', p_min_sqm numeric DEFAULT NULL,
  p_max_sqm numeric DEFAULT NULL, p_rooms text[] DEFAULT '{}',
  p_deal text[] DEFAULT '{}', p_neighborhood text[] DEFAULT '{}'
) RETURNS SETOF reporting.price_changes
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pc.* FROM public.price_changes_filtered(
    p_from, p_through, p_category, p_min_sqm, p_max_sqm,
    p_rooms, p_deal, p_neighborhood) pc
$$;

CREATE OR REPLACE FUNCTION reporting.market_daily_filtered(
  p_from_day date, p_through_day date,
  p_category text[] DEFAULT '{}', p_min_sqm numeric DEFAULT NULL,
  p_max_sqm numeric DEFAULT NULL, p_rooms text[] DEFAULT '{}',
  p_deal text[] DEFAULT '{}', p_neighborhood text[] DEFAULT '{}'
) RETURNS TABLE(day date, inventory_count bigint, priced_count bigint,
  p25 numeric, median numeric, p75 numeric, estimated_count bigint,
  stale_count bigint, provisional_day boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.market_daily_filtered(
    p_from_day, p_through_day, p_category, p_min_sqm, p_max_sqm,
    p_rooms, p_deal, p_neighborhood)
$$;

-- This existing read-only function also reads a private OLAP table directly.
ALTER FUNCTION reporting.listing_comparables(bigint) SECURITY DEFINER;
ALTER FUNCTION reporting.listing_comparables(bigint)
  SET search_path = pg_catalog, reporting, olap, pg_temp;

REVOKE EXECUTE ON FUNCTION reporting.dashboard_numeric(text),
  reporting.room_bucket(text),
  reporting.listings_filtered(text[], numeric, numeric, text[], boolean),
  reporting.listings_closed_filtered(text[], numeric, numeric, text[]),
  reporting.price_changes_filtered(timestamptz, timestamptz, text[], numeric, numeric, text[], text[], text[]),
  reporting.market_daily_filtered(date, date, text[], numeric, numeric, text[], text[], text[])
FROM PUBLIC;
-- zz-database-roles.sh applies SELECT/EXECUTE grants after migrations/restores.

-- <<< 18-dashboard-reporting-access.sql

-- >>> 19-incremental-olap-publication.sql
-- Article/day-scoped OLAP publication.
--
-- The canonical incremental publication keeps the full refresh untouched while
-- making normal cycles replace only grains invalidated by the scrape.  The
-- source functions below push article predicates into the expensive evidence
-- resolution and windowing steps.

CREATE OR REPLACE FUNCTION reporting.latest_resolved_price_evidence(
  p_article_id bigint
) RETURNS SETOF reporting.resolved_price_evidence
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT e.id, e.article_id, e.effective_at, e.ingested_at, e.price,
         e.price_state, e.source, e.provenance, e.observed_at, e.renewed_at,
         e.effective_at_basis,
         reporting.comparison_currency(e.provenance ->> 'currency'),
         CASE
           WHEN e.provenance ? 'dealType' THEN
             CASE e.provenance ->> 'dealType'
               WHEN 'sale' THEN false WHEN 'rent' THEN true ELSE NULL::boolean
             END
           ELSE state.is_rent
         END
    FROM (
      SELECT DISTINCT ON (p.article_id, p.effective_at) p.*
        FROM public.listing_price_events p
       WHERE p.article_id = $1 AND p.effective_at <= now()
       ORDER BY p.article_id, p.effective_at,
                CASE WHEN p.source IN ('search', 'detail') THEN 0 ELSE 1 END,
                CASE p.price_state
                  WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                  WHEN 'unpriced' THEN 2 ELSE 3 END,
                p.id DESC
    ) e
    LEFT JOIN LATERAL (
      SELECT h.is_rent FROM public.listing_state_history h
       WHERE h.article_id=e.article_id AND h.effective_at<=e.effective_at
         AND h.is_rent IS NOT NULL
       ORDER BY h.effective_at DESC, h.id DESC LIMIT 1
    ) state ON true
   ORDER BY e.effective_at DESC, e.id DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION reporting.resolved_price_evidence_for_articles(
  p_article_ids bigint[]
) RETURNS SETOF reporting.resolved_price_evidence
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  WITH picked AS (
    SELECT DISTINCT ON (p.article_id, p.effective_at)
           p.id, p.article_id, p.effective_at, p.ingested_at, p.price,
           p.price_state, p.source, p.provenance, p.observed_at,
           p.renewed_at, p.effective_at_basis
      FROM public.listing_price_events p
     WHERE p.article_id = ANY(COALESCE($1, '{}'::bigint[]))
       AND p.effective_at <= now()
     ORDER BY p.article_id, p.effective_at,
              CASE WHEN p.source IN ('search', 'detail') THEN 0 ELSE 1 END,
              CASE p.price_state
                WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                WHEN 'unpriced' THEN 2 ELSE 3 END,
              p.id DESC
  )
  SELECT p.id, p.article_id, p.effective_at, p.ingested_at, p.price,
         p.price_state, p.source, p.provenance, p.observed_at,
         p.renewed_at, p.effective_at_basis,
         reporting.comparison_currency(p.provenance ->> 'currency') AS currency_normalized,
         CASE
           WHEN p.provenance ? 'dealType' THEN
             CASE p.provenance ->> 'dealType'
               WHEN 'sale' THEN false WHEN 'rent' THEN true ELSE NULL::boolean
             END
           ELSE state.is_rent
         END AS evidence_is_rent
    FROM picked p
    LEFT JOIN LATERAL (
      SELECT h.is_rent
        FROM public.listing_state_history h
       WHERE h.article_id = p.article_id
         AND h.effective_at <= p.effective_at
         AND h.is_rent IS NOT NULL
       ORDER BY h.effective_at DESC, h.id DESC
       LIMIT 1
    ) state ON true
$$;

CREATE OR REPLACE FUNCTION reporting.comparison_price_changes_source_for_articles(
  p_article_ids bigint[]
) RETURNS SETOF olap.comparison_price_changes
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  WITH evidence AS MATERIALIZED (
    SELECT *
      FROM reporting.resolved_price_evidence_for_articles($1)
  ), ordered AS (
    SELECT e.*,
           lag(e.price) OVER w AS prior_price,
           lag(e.price_state) OVER w AS prior_state,
           lag(e.currency_normalized) OVER w AS prior_currency,
           lag(e.evidence_is_rent) OVER w AS prior_is_rent,
           lag(e.effective_at) OVER w AS prior_effective_at
      FROM evidence e
     WINDOW w AS (PARTITION BY e.article_id ORDER BY e.effective_at, e.id)
  ), current_inputs AS MATERIALIZED (
    SELECT article_id, cycle_opened_at, is_rent
      FROM reporting.current_comparison_inputs
     WHERE article_id = ANY(COALESCE($1, '{}'::bigint[]))
  )
  SELECT e.article_id, e.effective_at, e.prior_effective_at,
         e.prior_price, e.price, e.price - e.prior_price AS delta,
         (100::numeric * (e.price - e.prior_price)) / e.prior_price AS pct_change,
         CASE WHEN e.evidence_is_rent THEN 'rent'::text ELSE 'sale'::text END,
         e.currency_normalized
    FROM ordered e
    JOIN current_inputs l USING (article_id)
   WHERE e.effective_at >= l.cycle_opened_at
     AND e.prior_effective_at >= l.cycle_opened_at
     AND e.evidence_is_rent = l.is_rent
     AND e.prior_is_rent = e.evidence_is_rent
     AND reporting.comparison_price_reason(
           e.price, e.price_state, e.currency_normalized, e.evidence_is_rent) IS NULL
     AND reporting.comparison_price_reason(
           e.prior_price, e.prior_state, e.prior_currency, e.prior_is_rent) IS NULL
     AND e.price <> e.prior_price
     AND NOT EXISTS (
       SELECT 1
         FROM public.listing_state_history h
        WHERE h.article_id = e.article_id
          AND h.effective_at > e.prior_effective_at
          AND h.effective_at <= e.effective_at
          AND h.is_rent IS NOT NULL
          AND h.is_rent <> e.evidence_is_rent
     )
$$;

COMMENT ON FUNCTION reporting.resolved_price_evidence_for_articles(bigint[]) IS
  'Canonical resolved price evidence with the article predicate pushed before DISTINCT ON.';
COMMENT ON FUNCTION reporting.comparison_price_changes_source_for_articles(bigint[]) IS
  'Incremental comparison changes with article-scoped evidence resolution.';

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean)
RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
LANGUAGE plpgsql
SET jit TO 'off'
AS $$
DECLARE
  v_previous_at timestamptz;
  v_id bigint;
  v_at timestamptz := now();
  v_rows bigint;
  v_total bigint := 0;
  v_watermark timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch dashboard OLAP refresh', 0));
  SELECT s.refreshed_at INTO v_previous_at
    FROM olap.refresh_state s WHERE s.mart = 'daily_listing_facts';
  IF p_force_full OR v_previous_at IS NULL THEN
    RETURN QUERY SELECT * FROM reporting.refresh_dashboard_olap_full();
    DELETE FROM analytics_daily_olap_dirty;
    RETURN;
  END IF;
  v_id := nextval('olap.refresh_id_seq');

  CREATE TEMP TABLE olap_dirty_days(day date PRIMARY KEY, generation bigint NOT NULL)
    ON COMMIT DROP;
  INSERT INTO olap_dirty_days SELECT day, generation FROM analytics_daily_olap_dirty;

  CREATE TEMP TABLE olap_dirty_articles(article_id bigint PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO olap_dirty_articles
  SELECT article_id FROM (
    SELECT article_id FROM listing_state_history WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listing_price_events WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listings
      WHERE first_seen > v_previous_at OR last_seen > v_previous_at
         OR closed_at > v_previous_at OR renewed_at > v_previous_at
         OR published_at > v_previous_at OR details_fetched_at > v_previous_at
    UNION SELECT article_id FROM public.olap_article_dirty
    UNION SELECT article_id FROM olap.lifecycle_cycles
      WHERE NOT is_closed AND current_cycle_age_days IS DISTINCT FROM greatest(
         floor(extract(epoch FROM (now()-opened_at))/86400.0)::int, 0)
  ) changed;

  CREATE TEMP TABLE olap_score_dirty_articles(article_id bigint PRIMARY KEY)
    ON COMMIT DROP;
  INSERT INTO olap_score_dirty_articles
  SELECT article_id FROM listing_state_history WHERE ingested_at > v_previous_at
  UNION SELECT article_id FROM listing_price_events WHERE ingested_at > v_previous_at
  UNION SELECT article_id FROM listings
    WHERE first_seen > v_previous_at OR last_seen > v_previous_at
       OR closed_at > v_previous_at OR renewed_at > v_previous_at
       OR published_at > v_previous_at OR details_fetched_at > v_previous_at;
  -- Audited rewrites and membership changes are score-relevant too.
  INSERT INTO olap_score_dirty_articles
  SELECT article_id FROM public.olap_article_dirty
  ON CONFLICT (article_id) DO NOTHING;

  -- Keep the publication boundary observable to statement-level auditing
  -- triggers even when this cycle has no listing grain to replace.
  INSERT INTO olap.listings
    SELECT l.* FROM listings l WHERE false;

  IF EXISTS (SELECT 1 FROM olap_score_dirty_articles) THEN
    -- Scores are population-sensitive, so rebuild the active snapshot only
    -- when an article actually changed. An idle cycle must not pay the full
    -- population-wide comparison cost.
    DELETE FROM olap.current_listing_scores;
    INSERT INTO olap.current_listing_scores
      SELECT * FROM reporting.current_listing_scores_source;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;


    DELETE FROM olap.listings l USING olap_dirty_articles d WHERE l.article_id=d.article_id;
    INSERT INTO olap.listings SELECT l.* FROM listings l JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.listing_categories c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.listing_categories
      SELECT DISTINCT sr.article_id, ss.category
        FROM search_results sr JOIN saved_searches ss USING(search_key)
        JOIN olap_dirty_articles d USING(article_id)
       WHERE nullif(btrim(ss.category),'') IS NOT NULL;
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles d WHERE m.article_id=d.article_id;
    DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.lifecycle_cycles
      SELECT s.* FROM reporting.lifecycle_cycles_source_for_articles(
        ARRAY(SELECT article_id FROM olap_dirty_articles)) s;
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    INSERT INTO olap.lifecycle_movements
      SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s
       JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.comparison_price_changes c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.comparison_price_changes
      SELECT * FROM reporting.comparison_price_changes_source_for_articles(
        ARRAY(SELECT article_id FROM olap_dirty_articles));
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.listing_price_changes c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.listing_price_changes
      SELECT s.* FROM v_listing_price_changes_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.listing_exit_economics c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.listing_exit_economics
      SELECT s.* FROM v_listing_exit_economics_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.public_current_listings c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.public_current_listings
      SELECT s.* FROM reporting.current_listings_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.public_price_reductions c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.public_price_reductions
      SELECT s.* FROM reporting.price_reductions_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.public_exit_cycles c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.public_exit_cycles
      SELECT s.* FROM reporting.exit_cycles_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  END IF;

  -- Lifecycle age is derived from the clock. Advance age-only rows directly;
  -- rebuilding their complete history would turn a daily tick into a full
  -- evidence refresh.
  UPDATE olap.lifecycle_cycles c
     SET current_cycle_age_days = greatest(
       floor(extract(epoch FROM (now() - c.opened_at)) / 86400.0)::int, 0)
    FROM olap_dirty_articles d
   WHERE c.article_id = d.article_id
     AND NOT c.is_closed
     AND NOT EXISTS (
       SELECT 1 FROM olap_score_dirty_articles sd
       WHERE sd.article_id = d.article_id
     );

  DELETE FROM public.olap_article_dirty d
   WHERE EXISTS (SELECT 1 FROM olap_dirty_articles x WHERE x.article_id=d.article_id);

  SELECT max(last_seen) INTO v_watermark FROM olap.current_listing_scores;

  IF EXISTS (SELECT 1 FROM olap_dirty_days) THEN
    DELETE FROM olap.daily_listing_facts f USING olap_dirty_days d WHERE f.day=d.day;
    INSERT INTO olap.daily_listing_facts
      SELECT * FROM reporting.daily_listing_facts_source_for_days(
        ARRAY(SELECT day FROM olap_dirty_days));
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.market_daily m USING olap_dirty_days d WHERE m.day=d.day;
    INSERT INTO olap.market_daily
      SELECT s.* FROM v_market_daily_source s JOIN olap_dirty_days d USING(day);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.public_daily_market m USING olap_dirty_days d WHERE m.day=d.day;
    INSERT INTO olap.public_daily_market
      SELECT s.* FROM reporting.daily_market_source s JOIN olap_dirty_days d USING(day);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM analytics_daily_olap_dirty q USING olap_dirty_days d
      WHERE q.day=d.day AND q.generation=d.generation;
  END IF;

  -- Freshness is a tiny aggregate and has no article/day grain.
  DELETE FROM olap.public_freshness;
  INSERT INTO olap.public_freshness SELECT * FROM reporting.freshness_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

  INSERT INTO olap.refresh_state(mart,refreshed_at,row_count,source_watermark,refresh_id) VALUES
    ('listings',v_at,(SELECT count(*) FROM olap.listings),(SELECT max(last_seen) FROM olap.listings),v_id),
    ('current_listing_scores',v_at,(SELECT count(*) FROM olap.current_listing_scores),v_watermark,v_id),
    ('daily_listing_facts',v_at,(SELECT count(*) FROM olap.daily_listing_facts),v_at,v_id),
    ('lifecycle_cycles',v_at,(SELECT count(*) FROM olap.lifecycle_cycles),v_at,v_id),
    ('lifecycle_movements',v_at,(SELECT count(*) FROM olap.lifecycle_movements),v_at,v_id),
    ('comparison_price_changes',v_at,(SELECT count(*) FROM olap.comparison_price_changes),v_at,v_id),
    ('legacy_dashboard_contracts',v_at,(SELECT count(*) FROM olap.market_daily)+(SELECT count(*) FROM olap.listing_price_changes)+(SELECT count(*) FROM olap.listing_exit_economics),v_at,v_id),
    ('public_dashboard_contracts',v_at,(SELECT count(*) FROM olap.public_current_listings)+(SELECT count(*) FROM olap.public_daily_market)+(SELECT count(*) FROM olap.public_price_reductions)+(SELECT count(*) FROM olap.public_exit_cycles)+(SELECT count(*) FROM olap.public_freshness),v_at,v_id)
  ON CONFLICT(mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,row_count=excluded.row_count,
    source_watermark=excluded.source_watermark,refresh_id=excluded.refresh_id;

  UPDATE reporting.current_market_refresh_state SET refreshed_at=v_at,
    row_count=(SELECT count(*) FROM olap.current_listing_scores),source_max_last_seen=v_watermark
   WHERE singleton;
  RETURN QUERY SELECT v_id,v_at,v_total;
END
$$;

-- <<< 19-incremental-olap-publication.sql

-- >>> 20-current-comparison-inputs.sql
-- Canonical article-scoped current-input view.


CREATE OR REPLACE VIEW reporting.current_comparison_inputs AS
 WITH evidence AS (
         SELECT l.article_id,
            l.url,
            l.title,
            l.sqm,
            l.rooms,
            l.is_rent,
                CASE
                    WHEN l.is_rent THEN 'rent'::text
                    ELSE 'sale'::text
                END AS deal,
            l.latitude,
            l.longitude,
            l.first_seen,
            l.last_seen,
            l.seller_type,
            l.condition,
            l.parking,
            l.garage,
            l.elevator,
            l.heating,
            l.floor_num,
            l.plot_sqm,
            l.year_built,
            l.bathrooms,
            l.rooms_detail,
                CASE
                    WHEN furnishing.found THEN furnishing.value
                    ELSE l.furnished
                END AS furnished,
            types.category_memberships,
            reporting.comparison_property_type(types.category_memberships) AS property_type,
            n.name AS neighborhood,
                CASE
                    WHEN (l.rooms ~ '^[0-9]+[+]?$'::text) THEN
                    CASE
                        WHEN ((split_part(l.rooms, '+'::text, 1))::numeric >= (4)::numeric) THEN '4+'::text
                        ELSE l.rooms
                    END
                    ELSE NULL::text
                END AS room_bucket,
            p.price AS resolved_price,
            COALESCE(p.price_state, 'unknown'::text) AS price_state,
            p.currency_normalized AS currency,
            p.effective_at AS price_effective_at,
            p.evidence_is_rent,
            cycle.opened_at AS cycle_opened_at,
                CASE
                    WHEN (cycle.opened_at IS NOT NULL) THEN (floor((EXTRACT(epoch FROM (now() - cycle.opened_at)) / (86400)::numeric)))::integer
                    ELSE NULL::integer
                END AS current_cycle_age_days,
            COALESCE((cycle.cycle_no > 1), false) AS reopened,
            now() AS benchmark_at,
            1 AS score_version
           FROM (((((reporting.current_listings l
             LEFT JOIN LATERAL ( SELECT array_agg(DISTINCT ss.category ORDER BY ss.category) AS category_memberships
                   FROM (public.search_results sr
                     JOIN public.saved_searches ss USING (search_key))
                  WHERE (sr.article_id = l.article_id)) types ON (true))
             LEFT JOIN public.neighborhoods n ON ((n.name = COALESCE(NULLIF(l.location, ''::text), public.neighborhood_of(l.latitude, l.longitude)))))
             LEFT JOIN LATERAL ( SELECT e.id,
                    e.article_id,
                    e.effective_at,
                    e.ingested_at,
                    e.price,
                    e.price_state,
                    e.source,
                    e.provenance,
                    e.observed_at,
                    e.renewed_at,
                    e.effective_at_basis,
                    e.currency_normalized,
                    e.evidence_is_rent
                   FROM reporting.latest_resolved_price_evidence(l.article_id) e) p ON (true))
             LEFT JOIN LATERAL ( SELECT true AS found,
                        CASE (h.filter_attributes ->> 'furnished'::text)
                            WHEN 'true'::text THEN true
                            WHEN 'false'::text THEN false
                            ELSE NULL::boolean
                        END AS value
                   FROM public.listing_state_history h
                  WHERE ((h.article_id = l.article_id) AND (h.effective_at <= now()) AND (h.filter_attributes ? 'furnished'::text))
                  ORDER BY h.effective_at DESC, h.id DESC
                 LIMIT 1) furnishing ON (true))
             LEFT JOIN LATERAL ( SELECT c.article_id,
                    c.cycle_no,
                    c.opened_at,
                    c.closed_at,
                    c.first_price_at,
                    c.opening_price,
                    c.is_closed,
                    c.days_listed
                   FROM public.v_listing_lifecycle_cycles c
                  WHERE ((c.article_id = l.article_id) AND (c.opened_at <= now()))
                  ORDER BY c.opened_at DESC, c.cycle_no DESC
                 LIMIT 1) cycle ON ((cycle.closed_at IS NULL)))
        ), quality AS (
         SELECT e.article_id,
            e.url,
            e.title,
            e.sqm,
            e.rooms,
            e.is_rent,
            e.deal,
            e.latitude,
            e.longitude,
            e.first_seen,
            e.last_seen,
            e.seller_type,
            e.condition,
            e.parking,
            e.garage,
            e.elevator,
            e.heating,
            e.floor_num,
            e.plot_sqm,
            e.year_built,
            e.bathrooms,
            e.rooms_detail,
            e.furnished,
            e.category_memberships,
            e.property_type,
            e.neighborhood,
            e.room_bucket,
            e.resolved_price,
            e.price_state,
            e.currency,
            e.price_effective_at,
            e.evidence_is_rent,
            e.cycle_opened_at,
            e.current_cycle_age_days,
            e.reopened,
            e.benchmark_at,
            e.score_version,
            COALESCE(
                CASE
                    WHEN ((e.evidence_is_rent IS DISTINCT FROM e.is_rent) AND (e.price_state = 'valid'::text)) THEN 'Price evidence belongs to another or unknown deal segment'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN (EXISTS ( SELECT 1
                       FROM public.listing_state_history h
                      WHERE ((h.article_id = e.article_id) AND (h.effective_at > e.price_effective_at) AND (h.effective_at <= now()) AND (h.is_rent IS DISTINCT FROM e.is_rent) AND (h.is_rent IS NOT NULL)))) THEN 'Price evidence predates a deal switch'::text
                    ELSE NULL::text
                END, reporting.comparison_price_reason(e.resolved_price, e.price_state, e.currency, e.is_rent)) AS price_reason
           FROM evidence e
        ), eligible AS (
         SELECT q.article_id,
            q.url,
            q.title,
            q.sqm,
            q.rooms,
            q.is_rent,
            q.deal,
            q.latitude,
            q.longitude,
            q.first_seen,
            q.last_seen,
            q.seller_type,
            q.condition,
            q.parking,
            q.garage,
            q.elevator,
            q.heating,
            q.floor_num,
            q.plot_sqm,
            q.year_built,
            q.bathrooms,
            q.rooms_detail,
            q.furnished,
            q.category_memberships,
            q.property_type,
            q.neighborhood,
            q.room_bucket,
            q.resolved_price,
            q.price_state,
            q.currency,
            q.price_effective_at,
            q.evidence_is_rent,
            q.cycle_opened_at,
            q.current_cycle_age_days,
            q.reopened,
            q.benchmark_at,
            q.score_version,
            q.price_reason,
                CASE
                    WHEN (q.price_reason IS NULL) THEN q.resolved_price
                    ELSE NULL::numeric
                END AS asking_price,
                CASE
                    WHEN ((q.price_reason IS NULL) AND (reporting.comparison_quality_reason(q.resolved_price, q.price_state, q.currency, q.sqm, q.is_rent) IS NULL)) THEN (q.resolved_price / q.sqm)
                    ELSE NULL::numeric
                END AS asking_rate,
            COALESCE(q.price_reason, reporting.comparison_quality_reason(q.resolved_price, q.price_state, q.currency, q.sqm, q.is_rent),
                CASE
                    WHEN (q.neighborhood IS NULL) THEN 'Missing mapped neighbourhood'::text
                    WHEN (q.property_type IS NULL) THEN 'Unknown or ambiguous property type'::text
                    WHEN (q.room_bucket IS NULL) THEN 'Missing or unsupported room bucket'::text
                    WHEN (q.is_rent AND (q.furnished IS NULL)) THEN 'Unknown or partial furnishing'::text
                    ELSE NULL::text
                END) AS score_input_reason
           FROM quality q
        )
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    is_rent,
    deal,
    latitude,
    longitude,
    first_seen,
    last_seen,
    seller_type,
    condition,
    parking,
    garage,
    elevator,
    heating,
    floor_num,
    plot_sqm,
    year_built,
    bathrooms,
    rooms_detail,
    furnished,
    category_memberships,
    property_type,
    neighborhood,
    room_bucket,
    resolved_price,
    price_state,
    currency,
    price_effective_at,
    evidence_is_rent,
    cycle_opened_at,
    current_cycle_age_days,
    reopened,
    benchmark_at,
    score_version,
    price_reason,
    asking_price,
    asking_rate,
    score_input_reason
   FROM eligible;


-- <<< 20-current-comparison-inputs.sql

-- >>> 21-audited-history-dirty.sql
-- Audited rewrites and membership changes must mark the affected article so
-- the next incremental OLAP publication refreshes scores and contracts.
CREATE TABLE IF NOT EXISTS public.olap_article_dirty (
  article_id bigint PRIMARY KEY,
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.prevent_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.history_maintenance', true) IN ('migration', 'retention') THEN
    IF TG_OP = 'UPDATE'
       AND (TG_TABLE_NAME LIKE 'listing_state_history%'
            OR TG_TABLE_NAME LIKE 'listing_price_events%'
            OR TG_TABLE_NAME LIKE 'price_history%'
            OR TG_TABLE_NAME LIKE 'listing_publication_evidence%') THEN
      NEW.ingested_at := now();
      INSERT INTO public.olap_article_dirty(article_id)
      VALUES (NEW.article_id)
      ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.olap_article_dirty(article_id)
      VALUES (OLD.article_id)
      ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE OR REPLACE FUNCTION public.mark_article_olap_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.olap_article_dirty(article_id)
  VALUES (COALESCE(NEW.article_id, OLD.article_id))
  ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS search_results_olap_dirty ON public.search_results;
CREATE TRIGGER search_results_olap_dirty
AFTER INSERT OR UPDATE OR DELETE ON public.search_results
FOR EACH ROW EXECUTE FUNCTION public.mark_article_olap_dirty();

-- <<< 21-audited-history-dirty.sql
