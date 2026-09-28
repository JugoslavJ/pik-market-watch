-- Phase 6 final cleanup. Run with writers stopped and a verified custom dump
-- available. This preserves PostGIS/extension objects in public and leaves the
-- migration ledger (public.schema_migrations) in place.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('lean.listings') IS NULL
     OR to_regclass('lean.price_history') IS NULL
     OR to_regclass('lean.raw_api_responses') IS NULL
     OR to_regclass('lean.scrape_run_pages') IS NULL THEN
    RAISE EXCEPTION 'lean domain tables and raw archive must exist before cleanup';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.listings p
    LEFT JOIN lean.listings l USING (article_id)
    WHERE l.article_id IS NULL
  ) THEN
    RAISE EXCEPTION 'public contains listing IDs missing from lean';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.listing_price_events p
    WHERE p.price_state = 'valid' AND p.price IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM lean.price_history l
        WHERE l.article_id = p.article_id
          AND l.observed_at = p.effective_at
          AND l.price = p.price
          AND l.source = p.source
      )
  ) THEN
    RAISE EXCEPTION 'public contains valid price history missing from lean';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.raw_api_responses s
    LEFT JOIN lean.raw_api_responses d USING (id)
    WHERE d.id IS NULL OR to_jsonb(s) IS DISTINCT FROM to_jsonb(d)
  ) THEN
    RAISE EXCEPTION 'raw response archive is not fully copied to lean';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.scrape_run_pages s
    LEFT JOIN lean.scrape_run_pages d USING (run_id, page_number, attempt)
    WHERE d.run_id IS NULL OR to_jsonb(s) IS DISTINCT FROM to_jsonb(d)
  ) THEN
    RAISE EXCEPTION 'scrape page archive is not fully copied to lean';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class target ON target.oid = c.confrelid
    JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
    WHERE c.contype = 'f'
      AND c.connamespace = 'lean'::regnamespace
      AND target_ns.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'lean still has foreign keys targeting public';
  END IF;
END $$;

-- These schemas contain the retired score generation and OLAP/reporting
-- contracts. Grafana is provisioned against lean before this migration runs.
DROP SCHEMA IF EXISTS olap CASCADE;
DROP SCHEMA IF EXISTS reporting CASCADE;

-- Monthly legacy history relations use inheritance. Remove each child before
-- its parent so no detached child tables remain behind.
DO $$
DECLARE
  child record;
BEGIN
  FOR child IN
    SELECT child_ns.nspname AS schema_name, child_rel.relname AS table_name
    FROM pg_inherits i
    JOIN pg_class parent_rel ON parent_rel.oid = i.inhparent
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent_rel.relnamespace
    JOIN pg_class child_rel ON child_rel.oid = i.inhrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child_rel.relnamespace
    WHERE parent_ns.nspname = 'public'
    ORDER BY child_ns.nspname, child_rel.relname
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE',
                   child.schema_name, child.table_name);
  END LOOP;
END $$;

-- Remove all remaining non-extension application relations from public. The
-- migration ledger remains available to adopt the lean canonical baseline.
DO $$
DECLARE
  obj record;
  drop_kind text;
BEGIN
  FOR obj IN
    SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND c.relname <> 'schema_migrations'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
      AND NOT (
        c.relkind = 'S' AND EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype IN ('a', 'i')
        )
      )
    ORDER BY CASE c.relkind WHEN 'v' THEN 0 WHEN 'm' THEN 0 ELSE 1 END,
             c.relname
  LOOP
    drop_kind := CASE obj.relkind
      WHEN 'S' THEN 'SEQUENCE'
      WHEN 'v' THEN 'VIEW'
      WHEN 'm' THEN 'MATERIALIZED VIEW'
      WHEN 'f' THEN 'FOREIGN TABLE'
      ELSE 'TABLE'
    END;
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE',
                   drop_kind, obj.relname);
  END LOOP;
END $$;

-- Remove application routines while leaving extension-owned PostGIS routines.
DO $$
DECLARE
  obj record;
  drop_kind text;
BEGIN
  FOR obj IN
    SELECT p.oid, p.proname, p.prokind,
           pg_get_function_identity_arguments(p.oid) AS identity_args
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass
          AND d.objid = p.oid
          AND d.deptype = 'e'
      )
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = obj.oid) THEN
      drop_kind := CASE WHEN obj.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END;
      EXECUTE format('DROP %s IF EXISTS public.%I(%s) CASCADE',
                     drop_kind, obj.proname, obj.identity_args);
    END IF;
  END LOOP;
END $$;

-- Remove any custom enum/domain types left after application tables/routines.
DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT t.typname
    FROM pg_type t
    WHERE t.typnamespace = 'public'::regnamespace
      AND t.typtype IN ('e', 'd')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.objid = t.oid
          AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', obj.typname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND c.relname <> 'schema_migrations'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.deptype = 'e'
      )
  ) THEN
    RAISE EXCEPTION 'non-extension public relations remain after cleanup';
  END IF;
  IF to_regclass('lean.raw_api_responses') IS NULL
     OR to_regclass('lean.scrape_run_pages') IS NULL THEN
    RAISE EXCEPTION 'lean raw archive disappeared during cleanup';
  END IF;
END $$;

COMMIT;
