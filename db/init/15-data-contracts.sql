-- Data contracts, retention, and validation.

-- Permit the evidence normalization below to update append-only evidence.
-- The setting is local to the migrator transaction and is cleared on commit.
SELECT set_config('app.history_maintenance', 'migration', true);

-- Normalize older evidence before strict data contracts are installed.

-- Older writers defaulted missing ingestion timestamps to now(), which can be
-- earlier than an upstream event's effective_at when source clocks are ahead.
UPDATE public.listing_price_events
   SET ingested_at = effective_at
 WHERE ingested_at < effective_at;

UPDATE public.listing_state_history
   SET ingested_at = effective_at
 WHERE event_type <> 'closed'
   AND ingested_at < effective_at;

-- The final evidence source domains include importer and fixture provenance.
ALTER TABLE public.listing_state_history
  DROP CONSTRAINT IF EXISTS history_source_ck;
ALTER TABLE public.listing_state_history
  ADD CONSTRAINT history_source_ck
  CHECK (source IN ('search', 'detail', 'lifecycle', 'fixture'));

ALTER TABLE public.listing_price_events
  DROP CONSTRAINT IF EXISTS price_event_source_ck;
ALTER TABLE public.listing_price_events
  ADD CONSTRAINT price_event_source_ck
  CHECK (source IN (
    'search',
    'detail',
    'api_price_history',
    'legacy_price_history',
    'legacy_api_price_history',
    'legacy_import',
    'benchmark',
    'fixture'
  ));

DO $$
DECLARE t text;
BEGIN
  -- Unknown deal is an explicit OLAP state, not malformed data.  Replacing
  -- any earlier sale/rent-only constraint also makes this safe after a
  -- partially completed deployment.
  FOREACH t IN ARRAY ARRAY[
    'olap.public_current_listings', 'olap.public_daily_market',
    'olap.public_exit_cycles', 'olap.public_price_reductions',
    'olap.current_listing_scores', 'olap.daily_listing_facts',
    'olap.lifecycle_movements', 'olap.listing_price_changes'
  ] LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I',
                   t, replace(t, '.', '_') || '_deal_ck');
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (deal IS NULL OR deal IN (''sale'', ''rent'', ''unknown''))',
      t, replace(t, '.', '_') || '_deal_ck');
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_temporal_ck') THEN
    ALTER TABLE public.listing_state_history ADD CONSTRAINT history_temporal_ck
      CHECK (ingested_at >= effective_at OR event_type = 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_event_temporal_ck') THEN
    ALTER TABLE public.listing_price_events ADD CONSTRAINT price_event_temporal_ck
      CHECK (ingested_at >= effective_at);
  END IF;
END
$$;

-- Data contracts, append-only evidence protection, and governed history.
--
-- This is intentionally additive. Earlier init files are checksumed by the
-- migrator and must remain byte-for-byte stable after they have been applied.

-- ---------------------------------------------------------------------------
-- OLAP grains and value contracts
-- ---------------------------------------------------------------------------

-- Derived marts are rebuildable. Remove malformed/duplicate rows before the
-- constraints below are installed; the next refresh reconstructs them from
-- the canonical sources.
DELETE FROM olap.public_current_listings WHERE article_id IS NULL;
DELETE FROM olap.public_daily_market WHERE day IS NULL OR article_id IS NULL;
DELETE FROM olap.public_exit_cycles WHERE article_id IS NULL OR cycle_no IS NULL;
DELETE FROM olap.public_freshness WHERE category IS NULL;
DELETE FROM olap.public_price_reductions WHERE article_id IS NULL OR event_at IS NULL;
DELETE FROM olap.comparison_price_changes WHERE article_id IS NULL OR effective_at IS NULL;
DELETE FROM olap.current_listing_scores WHERE article_id IS NULL;
DELETE FROM olap.daily_listing_facts WHERE day IS NULL OR article_id IS NULL;
DELETE FROM olap.lifecycle_cycles WHERE article_id IS NULL OR cycle_no IS NULL OR opened_at IS NULL;
DELETE FROM olap.lifecycle_movements
 WHERE movement_type IS NULL OR event_at IS NULL OR event_day IS NULL
    OR article_id IS NULL OR cycle_no IS NULL;
DELETE FROM olap.listing_categories WHERE article_id IS NULL OR category IS NULL;
DELETE FROM olap.listing_exit_economics WHERE article_id IS NULL;
DELETE FROM olap.listing_price_changes WHERE article_id IS NULL OR effective_at IS NULL;
DELETE FROM olap.listings WHERE article_id IS NULL;
DELETE FROM olap.market_daily WHERE day IS NULL;

UPDATE public.saved_searches SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';
UPDATE olap.public_exit_cycles SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';
UPDATE olap.public_price_reductions SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';
UPDATE olap.daily_listing_facts SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';
UPDATE olap.lifecycle_cycles
   SET opening_category = NULL WHERE opening_category IS NOT NULL AND btrim(opening_category) = '';
UPDATE olap.lifecycle_cycles
   SET closing_category = NULL WHERE closing_category IS NOT NULL AND btrim(closing_category) = '';
UPDATE olap.lifecycle_movements SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';
UPDATE olap.listing_categories SET category = NULL WHERE category IS NOT NULL AND btrim(category) = '';
DELETE FROM olap.listing_categories WHERE category IS NULL;

UPDATE olap.public_daily_market
   SET stale_observation = COALESCE(stale_observation, false),
       provisional_day = COALESCE(provisional_day, false),
       membership_inferred = COALESCE(membership_inferred, false),
       attributes_inferred = COALESCE(attributes_inferred, false),
       price_state = COALESCE(NULLIF(btrim(price_state), ''), 'unknown');
UPDATE olap.daily_listing_facts
   SET stale_observation = COALESCE(stale_observation, false),
       provisional_day = COALESCE(provisional_day, false),
       membership_inferred = COALESCE(membership_inferred, false),
       attributes_inferred = COALESCE(attributes_inferred, false),
       price_state = COALESCE(NULLIF(btrim(price_state), ''), 'unknown');
UPDATE olap.lifecycle_cycles SET is_closed = COALESCE(is_closed, false);
UPDATE olap.market_daily
   SET new_n = COALESCE(new_n, 0), closed_n = COALESCE(closed_n, 0),
       reopened_n = COALESCE(reopened_n, 0), active_est = COALESCE(active_est, 0),
       stale_n = COALESCE(stale_n, 0), provisional_day = COALESCE(provisional_day, false);

DELETE FROM olap.public_current_listings a USING olap.public_current_listings b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id;
DELETE FROM olap.public_daily_market a USING olap.public_daily_market b
 WHERE a.ctid < b.ctid AND a.day = b.day AND a.article_id = b.article_id;
DELETE FROM olap.public_exit_cycles a USING olap.public_exit_cycles b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.cycle_no = b.cycle_no;
DELETE FROM olap.public_freshness a USING olap.public_freshness b
 WHERE a.ctid < b.ctid AND a.category = b.category;
DELETE FROM olap.public_price_reductions a USING olap.public_price_reductions b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.event_at = b.event_at;
DELETE FROM olap.comparison_price_changes a USING olap.comparison_price_changes b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.effective_at = b.effective_at;
DELETE FROM olap.current_listing_scores a USING olap.current_listing_scores b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id;
DELETE FROM olap.daily_listing_facts a USING olap.daily_listing_facts b
 WHERE a.ctid < b.ctid AND a.day = b.day AND a.article_id = b.article_id;
DELETE FROM olap.lifecycle_cycles a USING olap.lifecycle_cycles b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.cycle_no = b.cycle_no;
DELETE FROM olap.lifecycle_movements a USING olap.lifecycle_movements b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.cycle_no = b.cycle_no
   AND a.movement_type = b.movement_type;
DELETE FROM olap.listing_categories a USING olap.listing_categories b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.category = b.category;
DELETE FROM olap.listing_exit_economics a USING olap.listing_exit_economics b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id;
DELETE FROM olap.listing_price_changes a USING olap.listing_price_changes b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id AND a.effective_at = b.effective_at;
DELETE FROM olap.listings a USING olap.listings b
 WHERE a.ctid < b.ctid AND a.article_id = b.article_id;
DELETE FROM olap.market_daily a USING olap.market_daily b
 WHERE a.ctid < b.ctid AND a.day = b.day;

ALTER TABLE olap.public_current_listings
  ALTER COLUMN article_id SET NOT NULL;
ALTER TABLE olap.public_daily_market
  ALTER COLUMN day SET NOT NULL, ALTER COLUMN article_id SET NOT NULL,
  ALTER COLUMN price_state SET NOT NULL,
  ALTER COLUMN stale_observation SET DEFAULT false,
  ALTER COLUMN stale_observation SET NOT NULL,
  ALTER COLUMN provisional_day SET DEFAULT false,
  ALTER COLUMN provisional_day SET NOT NULL,
  ALTER COLUMN membership_inferred SET DEFAULT false,
  ALTER COLUMN membership_inferred SET NOT NULL,
  ALTER COLUMN attributes_inferred SET DEFAULT false,
  ALTER COLUMN attributes_inferred SET NOT NULL;
ALTER TABLE olap.public_exit_cycles
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN cycle_no SET NOT NULL,
  ALTER COLUMN opened_at SET NOT NULL;
ALTER TABLE olap.public_freshness
  ALTER COLUMN category SET NOT NULL, ALTER COLUMN configured_searches SET NOT NULL;
ALTER TABLE olap.public_price_reductions
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN event_at SET NOT NULL;
ALTER TABLE olap.comparison_price_changes
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN effective_at SET NOT NULL;
ALTER TABLE olap.current_listing_scores
  ALTER COLUMN article_id SET NOT NULL;
ALTER TABLE olap.daily_listing_facts
  ALTER COLUMN day SET NOT NULL, ALTER COLUMN article_id SET NOT NULL,
  ALTER COLUMN price_state SET NOT NULL,
  ALTER COLUMN membership_inferred SET DEFAULT false,
  ALTER COLUMN membership_inferred SET NOT NULL,
  ALTER COLUMN attributes_inferred SET DEFAULT false,
  ALTER COLUMN attributes_inferred SET NOT NULL,
  ALTER COLUMN stale_observation SET DEFAULT false,
  ALTER COLUMN stale_observation SET NOT NULL,
  ALTER COLUMN provisional_day SET DEFAULT false,
  ALTER COLUMN provisional_day SET NOT NULL;
ALTER TABLE olap.lifecycle_cycles
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN cycle_no SET NOT NULL,
  ALTER COLUMN opened_at SET NOT NULL, ALTER COLUMN is_closed SET NOT NULL;
ALTER TABLE olap.lifecycle_movements
  ALTER COLUMN movement_type SET NOT NULL, ALTER COLUMN event_at SET NOT NULL,
  ALTER COLUMN event_day SET NOT NULL, ALTER COLUMN article_id SET NOT NULL,
  ALTER COLUMN cycle_no SET NOT NULL;
ALTER TABLE olap.listing_categories
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN category SET NOT NULL;
ALTER TABLE olap.listing_exit_economics
  ALTER COLUMN article_id SET NOT NULL;
ALTER TABLE olap.listing_price_changes
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN effective_at SET NOT NULL,
  ALTER COLUMN source SET NOT NULL, ALTER COLUMN price_state SET NOT NULL;
ALTER TABLE olap.listings
  ALTER COLUMN article_id SET NOT NULL, ALTER COLUMN url SET NOT NULL,
  ALTER COLUMN title SET NOT NULL, ALTER COLUMN first_seen SET NOT NULL,
  ALTER COLUMN last_seen SET NOT NULL;
ALTER TABLE olap.market_daily
  ALTER COLUMN day SET NOT NULL,
  ALTER COLUMN new_n SET NOT NULL, ALTER COLUMN closed_n SET NOT NULL,
  ALTER COLUMN reopened_n SET NOT NULL, ALTER COLUMN active_est SET NOT NULL,
  ALTER COLUMN stale_n SET NOT NULL,
  ALTER COLUMN provisional_day SET DEFAULT false,
  ALTER COLUMN provisional_day SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_current_listings_grain_uq') THEN
    ALTER TABLE olap.public_current_listings ADD CONSTRAINT public_current_listings_grain_uq UNIQUE (article_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_daily_market_grain_uq') THEN
    ALTER TABLE olap.public_daily_market ADD CONSTRAINT public_daily_market_grain_uq UNIQUE (day, article_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_exit_cycles_grain_uq') THEN
    ALTER TABLE olap.public_exit_cycles ADD CONSTRAINT public_exit_cycles_grain_uq UNIQUE (article_id, cycle_no);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_freshness_grain_uq') THEN
    ALTER TABLE olap.public_freshness ADD CONSTRAINT public_freshness_grain_uq UNIQUE (category);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_price_reductions_grain_uq') THEN
    ALTER TABLE olap.public_price_reductions ADD CONSTRAINT public_price_reductions_grain_uq UNIQUE (article_id, event_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comparison_price_changes_grain_uq') THEN
    ALTER TABLE olap.comparison_price_changes ADD CONSTRAINT comparison_price_changes_grain_uq UNIQUE (article_id, effective_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'current_listing_scores_grain_uq') THEN
    ALTER TABLE olap.current_listing_scores ADD CONSTRAINT current_listing_scores_grain_uq UNIQUE (article_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_listing_facts_grain_uq') THEN
    ALTER TABLE olap.daily_listing_facts ADD CONSTRAINT daily_listing_facts_grain_uq UNIQUE (day, article_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lifecycle_cycles_grain_uq') THEN
    ALTER TABLE olap.lifecycle_cycles ADD CONSTRAINT lifecycle_cycles_grain_uq UNIQUE (article_id, cycle_no);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lifecycle_movements_grain_uq') THEN
    ALTER TABLE olap.lifecycle_movements ADD CONSTRAINT lifecycle_movements_grain_uq UNIQUE (article_id, cycle_no, movement_type);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listing_categories_grain_uq') THEN
    ALTER TABLE olap.listing_categories ADD CONSTRAINT listing_categories_grain_uq UNIQUE (article_id, category);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listing_exit_economics_grain_uq') THEN
    ALTER TABLE olap.listing_exit_economics ADD CONSTRAINT listing_exit_economics_grain_uq UNIQUE (article_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listing_price_changes_grain_uq') THEN
    ALTER TABLE olap.listing_price_changes ADD CONSTRAINT listing_price_changes_grain_uq UNIQUE (article_id, effective_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'olap_listings_grain_uq') THEN
    ALTER TABLE olap.listings ADD CONSTRAINT olap_listings_grain_uq UNIQUE (article_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'market_daily_grain_uq') THEN
    ALTER TABLE olap.market_daily ADD CONSTRAINT market_daily_grain_uq UNIQUE (day);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scrape_runs_status_ck') THEN
    ALTER TABLE public.scrape_runs ADD CONSTRAINT scrape_runs_status_ck
      CHECK (status IN ('running', 'ok', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scrape_runs_temporal_ck') THEN
    ALTER TABLE public.scrape_runs ADD CONSTRAINT scrape_runs_temporal_ck
      CHECK (finished_at IS NULL OR finished_at >= started_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scrape_runs_completion_ck') THEN
    ALTER TABLE public.scrape_runs ADD CONSTRAINT scrape_runs_completion_ck
      CHECK ((status = 'running' AND finished_at IS NULL AND NOT is_complete)
          OR (status <> 'running' AND finished_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_source_ck') THEN
    ALTER TABLE public.listing_state_history ADD CONSTRAINT history_source_ck
      CHECK (source IN ('search', 'detail', 'lifecycle'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_event_source_ck') THEN
    ALTER TABLE public.listing_price_events ADD CONSTRAINT price_event_source_ck
      CHECK (source IN ('search', 'detail', 'api_price_history', 'legacy_price_history', 'legacy_api_price_history'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_temporal_ck') THEN
    ALTER TABLE public.listing_state_history ADD CONSTRAINT history_temporal_ck
      CHECK (ingested_at >= effective_at OR event_type = 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_event_temporal_ck') THEN
    ALTER TABLE public.listing_price_events ADD CONSTRAINT price_event_temporal_ck
      CHECK (ingested_at >= effective_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_value_ranges_ck') THEN
    ALTER TABLE public.listing_state_history ADD CONSTRAINT history_value_ranges_ck
      CHECK ((sqm IS NULL OR sqm > 0) AND (price IS NULL OR price >= 0)
         AND (ppm2 IS NULL OR ppm2 >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_event_value_ranges_ck') THEN
    ALTER TABLE public.listing_price_events ADD CONSTRAINT price_event_value_ranges_ck
      CHECK ((price IS NULL OR price >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listing_daily_value_ranges_ck') THEN
    ALTER TABLE public.listing_daily ADD CONSTRAINT listing_daily_value_ranges_ck
      CHECK ((sqm IS NULL OR sqm > 0) AND (price IS NULL OR price >= 0)
         AND (ppm2 IS NULL OR ppm2 >= 0));
  END IF;
END
$$;

-- Categories and currencies are labels supplied by an upstream API, but a
-- blank label or an unbounded currency token is still a contract violation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'olap.public_current_listings', 'olap.public_daily_market',
    'olap.public_exit_cycles', 'olap.public_price_reductions',
    'olap.current_listing_scores', 'olap.daily_listing_facts',
    'olap.lifecycle_movements',
    'olap.listing_price_changes'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (deal IS NULL OR deal IN (''sale'', ''rent''))',
                     t, replace(t, '.', '_') || '_deal_ck');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('olap.comparison_price_changes', 'currency'),
    ('olap.current_listing_scores', 'currency'),
    ('olap.daily_listing_facts', 'currency'),
    ('olap.lifecycle_cycles', 'closing_currency'),
    ('olap.lifecycle_movements', 'currency')
  ) AS x(table_name, column_name) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IS NULL OR %I = ''KM'' OR %I ~ ''^[A-Z]{3}$'')',
        r.table_name, replace(r.table_name, '.', '_') || '_' || r.column_name || '_ck',
        r.column_name, r.column_name, r.column_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END
$$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.saved_searches', 'category'),
    ('olap.public_exit_cycles', 'category'),
    ('olap.public_price_reductions', 'category'),
    ('olap.daily_listing_facts', 'category'),
    ('olap.lifecycle_cycles', 'opening_category'),
    ('olap.lifecycle_cycles', 'closing_category'),
    ('olap.lifecycle_movements', 'category'),
    ('olap.listing_categories', 'category')
  ) AS x(table_name, column_name) LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IS NULL OR btrim(%I) <> '''')',
        r.table_name, replace(r.table_name, '.', '_') || '_' || r.column_name || '_nonblank_ck',
        r.column_name, r.column_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Evidence immutability and deletion policy
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.history_maintenance', true) IN ('migration', 'retention') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

DO $$
DECLARE t regclass; n text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.listing_state_history'::regclass,
    'public.listing_price_events'::regclass,
    'public.price_history'::regclass,
    'public.listing_publication_evidence'::regclass
  ] LOOP
    n := replace(t::text, '.', '_') || '_append_only';
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', n, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation()', n, t);
  END LOOP;
END
$$;

-- Listing deletion must not silently erase the evidence used to explain a
-- dashboard result. Retention is the explicit, audited deletion path.
ALTER TABLE public.listing_state_history DROP CONSTRAINT IF EXISTS listing_state_history_article_id_fkey;
ALTER TABLE public.listing_state_history ADD CONSTRAINT listing_state_history_article_id_fkey
  FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;
ALTER TABLE public.listing_price_events DROP CONSTRAINT IF EXISTS listing_price_events_article_id_fkey;
ALTER TABLE public.listing_price_events ADD CONSTRAINT listing_price_events_article_id_fkey
  FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;
ALTER TABLE public.listing_publication_evidence DROP CONSTRAINT IF EXISTS listing_publication_evidence_article_id_fkey;
ALTER TABLE public.listing_publication_evidence ADD CONSTRAINT listing_publication_evidence_article_id_fkey
  FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;
ALTER TABLE public.price_history DROP CONSTRAINT IF EXISTS price_history_article_id_fkey;
ALTER TABLE public.price_history ADD CONSTRAINT price_history_article_id_fkey
  FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Date partitions (inheritance keeps existing view and function OIDs stable)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_partition_policy (
  parent_schema text NOT NULL,
  parent_table text NOT NULL,
  partition_column text NOT NULL,
  key_type text NOT NULL,
  retention_days integer NOT NULL,
  months_ahead smallint NOT NULL DEFAULT 2,
  action text NOT NULL DEFAULT 'delete',
  PRIMARY KEY (parent_schema, parent_table),
  CHECK (key_type IN ('date', 'timestamptz')),
  CHECK (retention_days > 0),
  CHECK (months_ahead >= 0),
  CHECK (action IN ('delete', 'archive'))
);

CREATE TABLE IF NOT EXISTS public.analytics_partition_registry (
  parent_schema text NOT NULL,
  parent_table text NOT NULL,
  child_table text NOT NULL,
  from_at timestamptz NOT NULL,
  through_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_schema, child_table),
  UNIQUE (parent_schema, parent_table, from_at),
  CHECK (from_at < through_at)
);

CREATE TABLE IF NOT EXISTS public.analytics_retention_policy (
  table_schema text NOT NULL,
  table_name text NOT NULL,
  timestamp_column text NOT NULL,
  retention_days integer NOT NULL,
  action text NOT NULL DEFAULT 'delete',
  PRIMARY KEY (table_schema, table_name),
  CHECK (retention_days > 0),
  CHECK (action IN ('delete', 'archive'))
);

INSERT INTO public.analytics_retention_policy
  (table_schema, table_name, timestamp_column, retention_days)
VALUES
  ('public', 'scrape_runs', 'started_at', 730),
  ('public', 'maintenance_runs', 'finished_at', 90)
ON CONFLICT (table_schema, table_name) DO UPDATE SET
  timestamp_column = EXCLUDED.timestamp_column,
  retention_days = EXCLUDED.retention_days;

INSERT INTO public.analytics_partition_policy
  (parent_schema, parent_table, partition_column, key_type, retention_days, months_ahead)
VALUES
  ('public', 'listing_state_history', 'effective_at', 'timestamptz', 730, 2),
  ('public', 'listing_price_events', 'effective_at', 'timestamptz', 730, 2),
  ('public', 'price_history', 'scraped_at', 'timestamptz', 730, 2),
  ('public', 'listing_daily', 'day', 'date', 730, 2),
  ('olap', 'daily_listing_facts', 'day', 'date', 730, 2),
  ('olap', 'public_daily_market', 'day', 'date', 730, 2),
  ('olap', 'market_daily', 'day', 'date', 730, 2)
ON CONFLICT (parent_schema, parent_table) DO UPDATE SET
  partition_column = EXCLUDED.partition_column,
  key_type = EXCLUDED.key_type,
  retention_days = EXCLUDED.retention_days,
  months_ahead = EXCLUDED.months_ahead;

CREATE OR REPLACE FUNCTION public.route_analytics_partition_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE p record; v_value text; v_suffix text; v_child text; v_reg regclass;
BEGIN
  SELECT * INTO p FROM public.analytics_partition_policy
   WHERE parent_schema = TG_TABLE_SCHEMA AND parent_table = TG_TABLE_NAME;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_value := to_jsonb(NEW)->>p.partition_column;
  IF v_value IS NULL THEN RETURN NEW; END IF;
  v_suffix := CASE WHEN p.key_type = 'date'
    THEN to_char(v_value::date, 'YYYY_MM')
    ELSE to_char((v_value::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY_MM') END;
  v_child := TG_TABLE_NAME || '_' || v_suffix;
  v_reg := to_regclass(format('%I.%I', TG_TABLE_SCHEMA, v_child));
  IF v_reg IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('INSERT INTO %I.%I SELECT ($1).*', TG_TABLE_SCHEMA, v_child) USING NEW;
  RETURN NULL;
END
$$;

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
    v_start := GREATEST(v_start, date_trunc('month', now() - make_interval(days => p.retention_days))::date);
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

SELECT public.ensure_analytics_partitions();

-- Retention is the only supported deletion path for append-only evidence.
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
  FOR p IN SELECT * FROM public.analytics_partition_policy ORDER BY parent_schema, parent_table LOOP
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
  FOR p IN SELECT * FROM public.analytics_retention_policy ORDER BY table_schema, table_name LOOP
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
  'Drops expired monthly history partitions and deletes bounded legacy rows; all removals are explicit maintenance operations.';

-- ---------------------------------------------------------------------------
-- Post-refresh validation and operational policy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_contract_validation (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION reporting.validate_olap_contracts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, olap
AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  SELECT count(*) INTO n FROM olap.public_daily_market
   WHERE day IS NULL OR article_id IS NULL OR price_state IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract public_daily_market has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.daily_listing_facts
   WHERE day IS NULL OR article_id IS NULL OR price_state IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract daily_listing_facts has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.listing_categories
   WHERE article_id IS NULL OR category IS NULL OR btrim(category) = '';
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract listing_categories has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.market_daily
   WHERE day IS NULL OR new_n < 0 OR closed_n < 0 OR reopened_n < 0 OR active_est < 0 OR stale_n < 0;
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract market_daily has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.public_exit_cycles
   WHERE article_id IS NULL OR cycle_no IS NULL OR opened_at IS NULL
      OR (closed_at IS NOT NULL AND closed_at < opened_at);
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract public_exit_cycles has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM public.scrape_runs
   WHERE (status = 'running' AND finished_at IS NOT NULL)
      OR (status <> 'running' AND finished_at IS NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'OLTP contract scrape_runs has % malformed rows', n; END IF;
  v := jsonb_build_object('checked_at', now(), 'ok', true,
                          'daily_market_rows', (SELECT count(*) FROM olap.public_daily_market),
                          'daily_fact_rows', (SELECT count(*) FROM olap.daily_listing_facts),
                          'market_days', (SELECT count(*) FROM olap.market_daily));
  INSERT INTO public.analytics_contract_validation (ok, details) VALUES (true, v);
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.analytics_contract_validation (ok, details)
  VALUES (false, jsonb_build_object('checked_at', now(), 'error', SQLERRM));
  RAISE;
END
$$;

-- Keep evidence source domains controlled while accepting supported provenance
-- labels from importers, benchmarks, and fixtures.

ALTER TABLE public.listing_state_history
  DROP CONSTRAINT IF EXISTS history_source_ck;

ALTER TABLE public.listing_state_history
  ADD CONSTRAINT history_source_ck
  CHECK (source IN ('search', 'detail', 'lifecycle', 'fixture'));

ALTER TABLE public.listing_price_events
  DROP CONSTRAINT IF EXISTS price_event_source_ck;

ALTER TABLE public.listing_price_events
  ADD CONSTRAINT price_event_source_ck
  CHECK (source IN (
    'search',
    'detail',
    'api_price_history',
    'legacy_price_history',
    'legacy_api_price_history',
    'legacy_import',
    'benchmark',
    'fixture'
  ));

-- Unresolved deal evidence is a valid, explicit OLAP state.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'olap.public_current_listings', 'olap.public_daily_market',
    'olap.public_exit_cycles', 'olap.public_price_reductions',
    'olap.current_listing_scores', 'olap.daily_listing_facts',
    'olap.lifecycle_movements',
    'olap.listing_price_changes'
  ] LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I',
                   t, replace(t, '.', '_') || '_deal_ck');
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (deal IS NULL OR deal IN (''sale'', ''rent'', ''unknown''))',
      t, replace(t, '.', '_') || '_deal_ck');
  END LOOP;
END
$$;


-- Final current-state definitions folded from 17-history-retention.sql.
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
