-- Repair the boundary GiST index after PostGIS upgrades/restores.
--
-- Some databases can retain a GiST index bound to an older or mismatched
-- geometry operator family.  ST_Covers() then fails at query time with
-- "no spatial operator found" instead of evaluating the predicate.  Rebuild
-- the small neighborhood index against the current 2-D geometry opclass.
DROP INDEX IF EXISTS public.neighborhoods_boundary_gist;

CREATE INDEX neighborhoods_boundary_gist
  ON public.neighborhoods USING gist (boundary gist_geometry_ops_2d);
