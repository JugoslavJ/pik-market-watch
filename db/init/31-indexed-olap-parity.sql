CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_movements_grain_idx
  ON olap.lifecycle_movements(article_id, cycle_no, movement_type);

CREATE OR REPLACE FUNCTION reporting.validate_dashboard_olap()
RETURNS TABLE(mart text, source_rows bigint, mart_rows bigint,
              missing_rows bigint, unexpected_rows bigint)
LANGUAGE sql STABLE SET jit=off AS $$
  WITH source AS MATERIALIZED (
    SELECT * FROM reporting.daily_listing_facts_source
  ), compared AS (
    SELECT s.article_id AS source_id, m.article_id AS mart_id,
           to_jsonb(s) IS DISTINCT FROM to_jsonb(m) AS differs
      FROM source s FULL JOIN olap.daily_listing_facts m
        USING(day, article_id)
  )
  SELECT 'daily_listing_facts',
         count(source_id), count(mart_id),
         count(*) FILTER (WHERE source_id IS NOT NULL AND (mart_id IS NULL OR differs)),
         count(*) FILTER (WHERE mart_id IS NOT NULL AND (source_id IS NULL OR differs))
    FROM compared
  UNION ALL
  SELECT * FROM (
    WITH source AS MATERIALIZED (
      SELECT * FROM reporting.lifecycle_cycles_source
    ), compared AS (
      SELECT s.article_id AS source_id, m.article_id AS mart_id,
             (to_jsonb(s)-'current_cycle_age_days') IS DISTINCT FROM
             (to_jsonb(m)-'current_cycle_age_days') AS differs
        FROM source s FULL JOIN olap.lifecycle_cycles m
          USING(article_id, cycle_no)
    )
    SELECT 'lifecycle_cycles'::text,
           count(source_id), count(mart_id),
           count(*) FILTER (WHERE source_id IS NOT NULL AND (mart_id IS NULL OR differs)),
           count(*) FILTER (WHERE mart_id IS NOT NULL AND (source_id IS NULL OR differs))
      FROM compared
  ) cycles
  UNION ALL
  SELECT * FROM (
    WITH source AS MATERIALIZED (
      SELECT * FROM reporting.lifecycle_movements_source
    ), compared AS (
      SELECT s.article_id AS source_id, m.article_id AS mart_id,
             to_jsonb(s) IS DISTINCT FROM to_jsonb(m) AS differs
        FROM source s FULL JOIN olap.lifecycle_movements m
          USING(article_id, cycle_no, movement_type)
    )
    SELECT 'lifecycle_movements'::text,
           count(source_id), count(mart_id),
           count(*) FILTER (WHERE source_id IS NOT NULL AND (mart_id IS NULL OR differs)),
           count(*) FILTER (WHERE mart_id IS NOT NULL AND (source_id IS NULL OR differs))
      FROM compared
  ) movements
$$;

COMMENT ON FUNCTION reporting.validate_dashboard_olap() IS
  'Exact durable-field parity using one materialized source evaluation and indexed grain joins.';
