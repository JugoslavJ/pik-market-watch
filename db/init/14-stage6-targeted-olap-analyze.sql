-- Runtime publishers connect as olx_app and do not own OLAP relations, so keep
-- ANALYZE behind a narrowly scoped definer function. The only dynamic targets
-- accepted are children registered for olap.daily_listing_facts.
CREATE OR REPLACE FUNCTION public.analyze_published_olap(
    p_daily_partitions text[] DEFAULT ARRAY[]::text[]
) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_child text;
  v_count integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM unnest(COALESCE(p_daily_partitions, ARRAY[]::text[])) AS requested(child_table)
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.analytics_partition_registry r
        WHERE r.parent_schema = 'olap'
          AND r.parent_table = 'daily_listing_facts'
          AND r.child_table = requested.child_table
     )
  ) THEN
    RAISE EXCEPTION 'ANALYZE target is not a registered daily facts partition';
  END IF;

  ANALYZE olap.listings;
  ANALYZE olap.listing_categories;

  FOR v_child IN
    SELECT DISTINCT requested.child_table
      FROM unnest(COALESCE(p_daily_partitions, ARRAY[]::text[])) AS requested(child_table)
      JOIN public.analytics_partition_registry r
        ON r.parent_schema = 'olap'
       AND r.parent_table = 'daily_listing_facts'
       AND r.child_table = requested.child_table
     ORDER BY requested.child_table
  LOOP
    EXECUTE format('ANALYZE %I.%I', 'olap', v_child);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- The function can analyze only the two fixed current marts and registered
-- daily fact children; it cannot accept arbitrary relation identifiers.
REVOKE ALL ON FUNCTION public.analyze_published_olap(text[]) FROM PUBLIC;
