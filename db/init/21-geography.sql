-- Forward geography optimization. Keep exact containment and distance ordering,
-- but let the boundary GiST index reject candidates before geography casts.

ALTER TABLE public.neighborhoods
  ADD COLUMN IF NOT EXISTS boundary_geography geography(MultiPolygon, 4326);

UPDATE public.neighborhoods
   SET boundary_geography = boundary::geography
 WHERE boundary_geography IS NULL;

ALTER TABLE public.neighborhoods
  ALTER COLUMN boundary_geography SET NOT NULL;

CREATE INDEX IF NOT EXISTS neighborhoods_boundary_geography_gist
  ON public.neighborhoods USING gist (boundary_geography);

CREATE OR REPLACE FUNCTION public.neighborhood_of(
  p_lat double precision,
  p_lon double precision
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH point AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326) AS geom,
           ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography AS geog
     WHERE p_lat IS NOT NULL AND p_lon IS NOT NULL
  ), covered AS (
    SELECT n.name
      FROM point p
      JOIN public.neighborhoods n
        ON n.boundary && p.geom
       AND ST_Covers(n.boundary, p.geom)
     ORDER BY n.priority, n.name
     LIMIT 1
  ), nearby AS (
    SELECT n.name
      FROM point p
      JOIN public.neighborhoods n
        ON n.boundary && ST_Expand(p.geom, 0.07)
       AND ST_DWithin(n.boundary, p.geom, 0.07)
       AND ST_DWithin(n.boundary_geography, p.geog, 5000)
     ORDER BY ST_Distance(n.boundary_geography, p.geog),
              n.priority, n.name
     LIMIT 1
  )
  SELECT COALESCE((SELECT name FROM covered), (SELECT name FROM nearby))
$$;

-- The nearest-neighborhood contract is polygon-distance ordered. The indexed
-- envelope prefilter covers the Banja Luka neighborhood set while retaining a
-- deterministic exact-distance fallback for unusual/restored boundary data.
CREATE OR REPLACE FUNCTION reporting.nearest_neighborhoods(
  p_name text,
  p_limit integer DEFAULT 3
)
RETURNS TABLE(neighborhood text, neighbor_rank integer)
LANGUAGE sql
STABLE
STRICT
AS $$
  WITH subject AS MATERIALIZED (
    SELECT boundary, boundary_geography
      FROM public.neighborhoods
     WHERE name = p_name
  ), candidates AS MATERIALIZED (
    SELECT n.name, n.boundary, n.boundary_geography
      FROM subject s
      JOIN public.neighborhoods n
           ON n.name <> p_name
       AND n.boundary && ST_Expand(s.boundary, 0.25)
  ), ranked AS (
    SELECT c.name,
           ST_Distance(s.boundary_geography, c.boundary_geography) AS distance_m
      FROM subject s
      JOIN candidates c ON true
    WHERE p_limit > 0
  )
  SELECT name,
         row_number() OVER (ORDER BY distance_m, name)::integer
    FROM ranked
   ORDER BY distance_m, name
   LIMIT p_limit
$$;

COMMENT ON FUNCTION public.neighborhood_of(double precision, double precision) IS
  'Maps pins with indexed geometry containment and a bounded indexed nearby search.';
