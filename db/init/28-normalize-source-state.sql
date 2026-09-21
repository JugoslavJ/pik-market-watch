-- Finish the source-table normalization started by 25-versioned-listing-state.
-- Historical rows retain only their content-addressed state reference; the
-- reporting surface continues to expose the old state fields through the
-- *_state compatibility views below.

CREATE TEMP TABLE _state_normalization_views ON COMMIT DROP AS
SELECT c.oid,
       n.nspname AS schema_name,
       c.relname AS view_name,
       regexp_replace(
         regexp_replace(
           pg_get_viewdef(c.oid, true),
           $re$\m(?:public\.)?listing_state_history\M$re$,
           'public.listing_state_history_state', 'g'),
         $re$\m(?:public\.)?listing_daily\M$re$,
         'public.listing_daily_state', 'g') AS definition,
       false AS restored
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'v'
   AND n.nspname IN ('public', 'reporting', 'dashboard_public')
   AND NOT EXISTS (
     SELECT 1
       FROM pg_depend d
       JOIN pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid
        AND d.deptype = 'e'
   );

CREATE TEMP TABLE _state_normalization_functions ON COMMIT DROP AS
SELECT p.oid,
       n.nspname AS schema_name,
       p.proname,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       regexp_replace(
         regexp_replace(
           regexp_replace(
             pg_get_functiondef(p.oid),
             $re$(\m(?:FROM|JOIN)\s+(?:\(\s*)?)(?:public\.)?listing_state_history\M$re$,
             $rep$\1public.listing_state_history_state$rep$, 'gi'),
           $re$(\m(?:FROM|JOIN)\s+(?:\(\s*)?)(?:public\.)?listing_daily\M$re$,
           $rep$\1public.listing_daily_state$rep$, 'gi'),
         $re$\m(?:public\.)?listing_state_history\.$re$,
         'public.listing_state_history_state.', 'g') AS definition,
       false AS restored
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prokind = 'f'
   AND n.nspname IN ('public', 'reporting')
   AND NOT EXISTS (
     SELECT 1
       FROM pg_depend d
       JOIN pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid
        AND d.deptype = 'e'
   )
   AND p.proname NOT IN (
     'attach_history_version_refs',
     'attach_daily_version_refs',
     'normalize_listing_daily_flags',
     'resolve_listing_daily_sparse_state'
   );

-- These triggers depend on the payload columns and are recreated below with
-- state-version-aware definitions.
DROP TRIGGER IF EXISTS listing_state_history_15_version_refs
  ON public.listing_state_history;
DROP TRIGGER IF EXISTS listing_daily_10_resolve_sparse_state
  ON public.listing_daily;
DROP TRIGGER IF EXISTS listing_daily_15_version_refs
  ON public.listing_daily;
DROP TRIGGER IF EXISTS listing_daily_20_normalize_flags_insert
  ON public.listing_daily;
DROP TRIGGER IF EXISTS listing_daily_normalize_flags_update
  ON public.listing_daily;

-- Remove view dependencies before dropping the source columns. Definitions are
-- retained in the temporary table and recreated after the normalized helpers
-- exist. CASCADE also removes SQL functions whose return type is a view; those
-- definitions are retained in the function snapshot as well.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT schema_name, view_name FROM _state_normalization_views LOOP
    EXECUTE format('DROP VIEW IF EXISTS %I.%I CASCADE', v.schema_name, v.view_name);
  END LOOP;
END
$$;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM public.listing_state_history
   WHERE state_version_id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'cannot normalize listing_state_history: % rows have no state_version_id', n;
  END IF;

  SELECT count(*) INTO n
    FROM public.listing_daily
   WHERE state_version_id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'cannot normalize listing_daily: % rows have no state_version_id', n;
  END IF;
END
$$;

ALTER TABLE public.listing_state_history
  ALTER COLUMN state_version_id SET NOT NULL;
ALTER TABLE public.listing_daily
  ALTER COLUMN state_version_id SET NOT NULL;

ALTER TABLE public.listing_state_history
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS category_membership,
  DROP COLUMN IF EXISTS is_rent,
  DROP COLUMN IF EXISTS sqm,
  DROP COLUMN IF EXISTS rooms,
  DROP COLUMN IF EXISTS filter_attributes,
  DROP COLUMN IF EXISTS membership_inferred,
  DROP COLUMN IF EXISTS attributes_inferred;

ALTER TABLE public.listing_daily
  DROP COLUMN IF EXISTS is_rent,
  DROP COLUMN IF EXISTS sqm,
  DROP COLUMN IF EXISTS rooms,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS category_memberships,
  DROP COLUMN IF EXISTS filter_attributes,
  DROP COLUMN IF EXISTS membership_inferred,
  DROP COLUMN IF EXISTS attributes_inferred;

CREATE VIEW public.listing_state_history_state AS
SELECT h.id,
       h.article_id,
       h.effective_at,
       h.ingested_at,
       h.source,
       h.event_type,
       h.run_id,
       h.search_key,
       v.category,
       v.category_membership,
       v.is_rent,
       v.sqm,
       v.rooms,
       h.price,
       h.ppm2,
       v.filter_attributes,
       h.last_seen_at,
       h.closed_at,
       h.is_closed,
       v.membership_inferred,
       v.attributes_inferred,
       h.state_version_id,
       h.detail_version_id
  FROM public.listing_state_history h
  JOIN public.listing_state_versions v
    ON v.state_version_id = h.state_version_id;

CREATE VIEW public.listing_daily_state AS
SELECT d.day,
       d.article_id,
       d.price,
       d.price_state,
       d.ppm2,
       v.is_rent,
       v.sqm,
       v.rooms,
       v.category,
       d.location,
       d.state_effective_at,
       d.price_effective_at,
       v.membership_inferred,
       v.attributes_inferred,
       d.stale_observation,
       d.provisional_day,
       v.category_membership AS category_memberships,
       v.filter_attributes,
       d.neighborhood,
       d.resolved_state_version,
       d.state_version_id,
       d.detail_version_id
  FROM public.listing_daily d
  JOIN public.listing_state_versions v
    ON v.state_version_id = d.state_version_id;

-- Recreate functions and views in dependency order. A few definitions depend
-- on a sibling view/function, so retrying failed definitions is intentional.
DO $$
DECLARE
  f record;
  v record;
  progressed boolean;
  pending bigint;
BEGIN
  FOR f IN SELECT * FROM _state_normalization_functions LOOP
    BEGIN
      EXECUTE f.definition;
      UPDATE _state_normalization_functions
         SET restored = true WHERE oid = f.oid;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  FOR v IN SELECT * FROM _state_normalization_views LOOP
    BEGIN
      EXECUTE format('CREATE VIEW %I.%I AS %s',
        v.schema_name, v.view_name, v.definition);
      UPDATE _state_normalization_views
         SET restored = true WHERE oid = v.oid;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  LOOP
    progressed := false;
    FOR f IN SELECT * FROM _state_normalization_functions WHERE NOT restored LOOP
      BEGIN
        EXECUTE f.definition;
        UPDATE _state_normalization_functions
           SET restored = true WHERE oid = f.oid;
        progressed := true;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;
    FOR v IN SELECT * FROM _state_normalization_views WHERE NOT restored LOOP
      BEGIN
        EXECUTE format('CREATE VIEW %I.%I AS %s',
          v.schema_name, v.view_name, v.definition);
        UPDATE _state_normalization_views
           SET restored = true WHERE oid = v.oid;
        progressed := true;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;
    SELECT count(*) INTO pending
      FROM _state_normalization_functions WHERE NOT restored;
    SELECT pending + count(*) INTO pending
      FROM _state_normalization_views WHERE NOT restored;
    EXIT WHEN pending = 0;
    IF NOT progressed THEN
      RAISE EXCEPTION 'could not restore normalized source dependencies: % definitions remain', pending;
    END IF;
  END LOOP;
END
$$;

-- The legacy daily rebuild function still projected its state payload into
-- listing_daily. Patch its captured definition to resolve the payload once
-- more, then write only the version reference.
DO $$
DECLARE
  definition text;
  insert_at integer;
  diagnostics_at integer;
BEGIN
  SELECT f.definition INTO definition
    FROM _state_normalization_functions f
   WHERE f.proname = 'rebuild_listing_daily_legacy'
   ORDER BY f.oid DESC LIMIT 1;
  IF definition IS NULL THEN RETURN; END IF;

  -- The dependency rewrite above intentionally points reads at the
  -- compatibility view, but it also matches the FROM token in DELETE FROM.
  -- Restore the rebuild's write target to the normalized base table: the
  -- compatibility view joins state versions and is not automatically
  -- updatable.
  definition := regexp_replace(
    definition,
    $re$(\mDELETE\s+FROM\s+)(?:public\.)?listing_daily_state\M$re$,
    $rep$\1public.listing_daily$rep$,
    'gi');

  insert_at := position('INSERT INTO listing_daily' IN definition);
  diagnostics_at := position('GET DIAGNOSTICS' IN definition);
  IF insert_at = 0 OR diagnostics_at <= insert_at THEN
    RAISE EXCEPTION 'rebuild_listing_daily_legacy has an unexpected insert shape';
  END IF;

  definition := left(definition, insert_at - 1) || $body$
  INSERT INTO listing_daily (
    day, article_id, price, price_state, ppm2, state_version_id,
    location, state_effective_at, price_effective_at, stale_observation,
    provisional_day, neighborhood, resolved_state_version
  )
  SELECT f.day, f.article_id, f.price, f.price_state, f.ppm2,
         public.get_or_create_listing_state_version(
           f.category, f.category_memberships, f.is_rent, f.sqm, f.rooms,
           f.filter_attributes, f.membership_inferred, f.attributes_inferred),
         l.neighborhood, f.state_effective_at, f.price_effective_at,
         f.stale_observation, f.provisional_day, l.neighborhood, 1
    FROM filled f JOIN locations l USING (filter_attributes);

  $body$ || substr(definition, diagnostics_at);
  EXECUTE definition;
END
$$;

CREATE OR REPLACE FUNCTION public.attach_history_version_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.state_version_id IS NULL THEN
    NEW.state_version_id := public.get_or_create_listing_state_version(
      NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false);
  END IF;
  NEW.detail_version_id := public.ensure_listing_detail_version(
    NEW.article_id, NEW.effective_at);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.attach_daily_version_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.state_version_id IS NULL THEN
    NEW.state_version_id := public.get_or_create_listing_state_version(
      NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false);
  END IF;
  NEW.detail_version_id := public.ensure_listing_detail_version(
    NEW.article_id, NEW.state_effective_at);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.normalize_listing_daily_flags()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_neighborhood text;
BEGIN
  SELECT public.analytics_state_neighborhood(v.filter_attributes)
    INTO v_neighborhood
    FROM public.listing_state_versions v
   WHERE v.state_version_id = NEW.state_version_id;
  IF TG_OP = 'INSERT' OR NEW.location IS NULL
     OR NEW.state_version_id IS DISTINCT FROM OLD.state_version_id THEN
    NEW.location := v_neighborhood;
    NEW.neighborhood := v_neighborhood;
  ELSIF NEW.neighborhood IS NULL THEN
    NEW.neighborhood := NEW.location;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.resolve_listing_daily_sparse_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_endpoint timestamptz;
BEGIN
  IF NEW.state_version_id IS NULL THEN
    v_endpoint := CASE WHEN NEW.provisional_day
      THEN clock_timestamp() + interval '5 minutes'
      ELSE public.analytics_sarajevo_day_start(NEW.day + 1)
    END;
    SELECT h.state_version_id INTO NEW.state_version_id
      FROM public.listing_state_history_state h
     WHERE h.article_id = NEW.article_id
       AND h.effective_at < v_endpoint
       AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
     ORDER BY h.effective_at DESC, h.id DESC
     LIMIT 1;
    IF NEW.state_version_id IS NULL THEN
      NEW.state_version_id := public.get_or_create_listing_state_version(
        NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listing_state_history_15_version_refs
  ON public.listing_state_history;
CREATE TRIGGER listing_state_history_15_version_refs
  BEFORE INSERT ON public.listing_state_history
  FOR EACH ROW EXECUTE FUNCTION public.attach_history_version_refs();

DROP TRIGGER IF EXISTS listing_daily_10_resolve_sparse_state
  ON public.listing_daily;
CREATE TRIGGER listing_daily_10_resolve_sparse_state
  BEFORE INSERT ON public.listing_daily FOR EACH ROW
  WHEN (NEW.resolved_state_version = 0)
  EXECUTE FUNCTION public.resolve_listing_daily_sparse_state();

DROP TRIGGER IF EXISTS listing_daily_15_version_refs ON public.listing_daily;
CREATE TRIGGER listing_daily_15_version_refs
  BEFORE INSERT ON public.listing_daily
  FOR EACH ROW EXECUTE FUNCTION public.attach_daily_version_refs();

DROP TRIGGER IF EXISTS listing_daily_20_normalize_flags_insert
  ON public.listing_daily;
CREATE TRIGGER listing_daily_20_normalize_flags_insert
  BEFORE INSERT ON public.listing_daily FOR EACH ROW
  WHEN (NEW.resolved_state_version = 0)
  EXECUTE FUNCTION public.normalize_listing_daily_flags();

DROP TRIGGER IF EXISTS listing_daily_normalize_flags_update
  ON public.listing_daily;
CREATE TRIGGER listing_daily_normalize_flags_update
  BEFORE UPDATE ON public.listing_daily FOR EACH ROW
  EXECUTE FUNCTION public.normalize_listing_daily_flags();

COMMENT ON TABLE public.listing_state_versions IS
  'Content-addressed historical listing states shared by history and daily rows.';
COMMENT ON VIEW public.listing_state_history_state IS
  'Compatibility projection of listing_state_history joined to its canonical state version.';
COMMENT ON VIEW public.listing_daily_state IS
  'Compatibility projection of listing_daily joined to its canonical state version.';
