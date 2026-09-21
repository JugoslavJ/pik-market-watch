-- Canonical neighborhood geometry finalization.
--
-- Polygon rows are loaded by 09-neighborhood-data.sql. The table and spatial
-- indexes are defined by the canonical baseline before this derived data step.

WITH rings AS (
  SELECT n.name,
         ST_MakeLine(
           ARRAY_AGG(
             ST_SetSRID(ST_MakePoint(n.poly[i], n.poly[i + 1]), 4326)
             ORDER BY i
           )
         ) AS ring
    FROM public.neighborhoods AS n
   CROSS JOIN LATERAL generate_series(1, cardinality(n.poly) - 1, 2) AS i
   GROUP BY n.name
)
UPDATE public.neighborhoods AS n
   SET boundary = ST_Multi(ST_MakePolygon(r.ring))
  FROM rings AS r
 WHERE n.name = r.name
   AND n.boundary IS NULL;

UPDATE public.neighborhoods
   SET boundary_geography = boundary::geography
 WHERE boundary_geography IS NULL;

DO $$
DECLARE
  invalid_count integer;
BEGIN
  SELECT count(*)
    INTO invalid_count
    FROM public.neighborhoods
   WHERE boundary IS NULL
      OR boundary_geography IS NULL
      OR ST_SRID(boundary) <> 4326
      OR ST_GeometryType(boundary) <> 'ST_MultiPolygon'
      OR ST_IsEmpty(boundary)
      OR NOT ST_IsValid(boundary);

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'neighborhood geometry finalization failed validation for % neighborhood(s)',
      invalid_count;
  END IF;
END;
$$;

ALTER TABLE public.neighborhoods
  ALTER COLUMN boundary SET NOT NULL,
  ALTER COLUMN boundary_geography SET NOT NULL;
