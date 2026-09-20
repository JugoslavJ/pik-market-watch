-- Canonical postgis baseline.

-- PostGIS neighbourhood-boundary rollout.
--
-- Prerequisite for existing volumes: enable this extension with the database
-- administrator before the application-role migrator runs.  Fresh volumes run
-- this file through Docker's initdb entrypoint as the bootstrap administrator.
CREATE EXTENSION IF NOT EXISTS postgis;

-- Keep `poly` for one release: it permits assignment-result comparisons and a
-- straightforward rollback while callers migrate to `boundary`.
ALTER TABLE public.neighborhoods
  ADD COLUMN IF NOT EXISTS boundary geometry(MultiPolygon, 4326);

-- `poly` is a closed, flattened (longitude, latitude) ring.  Build a polygon
-- in SRID 4326, then normalize the stored representation to MultiPolygon.
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

DO $$
DECLARE
  invalid_count integer;
BEGIN
  SELECT count(*)
    INTO invalid_count
    FROM public.neighborhoods
   WHERE boundary IS NULL
      OR ST_SRID(boundary) <> 4326
      OR ST_GeometryType(boundary) <> 'ST_MultiPolygon'
      OR ST_IsEmpty(boundary)
      OR NOT ST_IsValid(boundary);

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'PostGIS boundary backfill failed validation for % neighborhood(s)',
      invalid_count;
  END IF;
END;
$$;

ALTER TABLE public.neighborhoods
  ALTER COLUMN boundary SET NOT NULL;

ALTER TABLE public.neighborhoods
  ADD CONSTRAINT neighborhoods_boundary_valid
  CHECK (
    ST_SRID(boundary) = 4326
    AND NOT ST_IsEmpty(boundary)
    AND ST_IsValid(boundary)
  );

CREATE INDEX neighborhoods_boundary_gist
  ON public.neighborhoods USING gist (boundary);

-- Preserve the public function signature while switching assignment to
-- indexed PostGIS predicates.  ST_Covers deliberately includes boundary
-- points; priority and name retain deterministic overlap resolution.
CREATE OR REPLACE FUNCTION public.neighborhood_of(
  p_lat double precision,
  p_lon double precision
)
RETURNS text
LANGUAGE sql STABLE
AS $$
  WITH point AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326) AS geom
     WHERE p_lat IS NOT NULL AND p_lon IS NOT NULL
  ), covered AS (
    SELECT n.name
      FROM point p
      JOIN public.neighborhoods n ON ST_Covers(n.boundary, p.geom)
     ORDER BY n.priority, n.name
     LIMIT 1
  ), nearby AS (
    SELECT n.name
      FROM point p
      JOIN public.neighborhoods n
        ON ST_DWithin(n.boundary::geography, p.geom::geography, 5000)
     ORDER BY ST_Distance(n.boundary::geography, p.geom::geography),
              n.priority,
              n.name
     LIMIT 1
  )
  SELECT COALESCE(
    (SELECT name FROM covered),
    (SELECT name FROM nearby)
  )
$$;

-- Rank true polygon-to-polygon distances instead of the arithmetic mean of
-- vertices, which is not a centroid and can lie outside concave polygons.
CREATE OR REPLACE FUNCTION reporting.nearest_neighborhoods(
  p_name text,
  p_limit integer DEFAULT 3
)
RETURNS TABLE(neighborhood text, neighbor_rank integer)
LANGUAGE sql STABLE STRICT
AS $$
  SELECT n.name,
         row_number() OVER (
           ORDER BY ST_Distance(s.boundary::geography, n.boundary::geography),
                    n.name
         )::integer
    FROM public.neighborhoods s
    CROSS JOIN public.neighborhoods n
   WHERE s.name = p_name
     AND n.name <> p_name
     AND p_limit > 0
   ORDER BY ST_Distance(s.boundary::geography, n.boundary::geography), n.name
   LIMIT p_limit
$$;

COMMENT ON COLUMN public.neighborhoods.boundary IS
  'Canonical PostGIS MultiPolygon boundary (WGS 84 / EPSG:4326); `poly` is retained temporarily for rollout comparison.';

-- Repair the boundary GiST index after PostGIS upgrades/restores.
--
-- Some databases can retain a GiST index bound to an older or mismatched
-- geometry operator family.  ST_Covers() then fails at query time with
-- "no spatial operator found" instead of evaluating the predicate.  Rebuild
-- the small neighborhood index against the current 2-D geometry opclass.
DROP INDEX IF EXISTS public.neighborhoods_boundary_gist;

CREATE INDEX neighborhoods_boundary_gist
  ON public.neighborhoods USING gist (boundary gist_geometry_ops_2d);
