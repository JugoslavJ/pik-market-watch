# PostGIS evaluation

## Recommendation

Adopt PostGIS in a separate, reversible migration after the canonical SQL
filenames are settled. Keep latitude and longitude columns during the rollout,
but replace the flat polygon arrays and custom geometry loops with PostGIS
geometry/geography operations.

The current dataset has only a few dozen neighbourhood polygons, so this is
primarily a correctness and maintainability improvement. A spatial index is
useful and future-proof, but is unlikely to be the dominant performance change
at the current scale.

## Proposed model

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE public.neighborhoods
  ADD COLUMN boundary geometry(MultiPolygon, 4326);

CREATE INDEX neighborhoods_boundary_gist
  ON public.neighborhoods USING gist (boundary);
```

Load the existing GeoJSON directly with `ST_GeomFromGeoJSON`, normalize it to
SRID 4326 and a multipolygon, and reject invalid or empty geometry before making
the column `NOT NULL`. Keep `poly` through one release so results can be compared
and rollback remains straightforward.

Use `ST_Covers(boundary, point)` for neighbourhood assignment. Unlike
`ST_Contains`, it assigns points on a shared polygon boundary instead of
considering the boundary outside both polygons. Continue resolving overlaps by
`priority, name` to preserve today's deterministic behavior.

For the five-kilometre fallback, use geography so distances are expressed in
metres:

```sql
ST_DWithin(
  boundary::geography,
  ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
  5000
)
```

For nearest-neighbour cohorts, rank polygon-to-polygon distance rather than the
current arithmetic mean of vertices. That mean is not a true centroid and can
fall outside a concave polygon.

## Rollout

1. Change the database image to a pinned PostGIS-on-PostgreSQL 16 build and
   confirm backup restore into that image.
2. Enable the extension and add nullable `boundary` alongside `poly`.
3. Backfill from the source GeoJSON; validate SRID, geometry type, validity and
   row counts.
4. Compare old and new assignment plus nearest-neighbour results on all stored
   listing coordinates, explicitly reviewing boundary and overlap differences.
5. Switch `neighborhood_of` and `nearest_neighborhoods` to PostGIS, retain their
   public signatures, and add SQL integration tests.
6. After one stable release, drop `poly`, `point_in_polygon` and
   `polygon_distance_m`.

Do not add `CREATE EXTENSION postgis` to the current baseline while the service
still uses the stock `postgres:16-alpine` image: the extension binaries are not
part of that image. Existing volumes can use the new image in place, but the
upgrade and restore path should be tested on a copy before deployment.
