-- Area maps need each boundary as GeoJSON, but the reporting role has no
-- access to the public schema, where PostGIS keeps its functions and
-- spatial_ref_sys. Store the outline when a boundary is written instead.
BEGIN;
ALTER TABLE lean.neighborhoods ADD COLUMN IF NOT EXISTS outline jsonb
  GENERATED ALWAYS AS (public.ST_AsGeoJSON(boundary)::jsonb) STORED;
COMMIT;
