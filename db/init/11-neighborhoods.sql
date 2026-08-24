-- ─────────────────────────────────────────────────────────────────────────────
-- Neighborhood mapping from map pins.
--
-- listings.location is never populated by olx.ba, but ~99% of listings carry
-- latitude/longitude pins. This migration ships approximate district polygons
-- for Banja Luka and assigns each pin its neighborhood:
--
--   neighborhoods(name, priority, poly)  — flattened polygon rings (lon,lat pairs)
--   point_in_polygon(lat, lon, poly)     — ray casting, plain plpgsql (no PostGIS)
--   neighborhood_of(lat, lon)            — first matching polygon by priority,
--                                          NULL when no district matches
--
-- The seeds are RECTANGLES approximating each district — good enough to tell
-- Obilićevo from Lauš, not survey-grade. To refine a boundary (or add a
-- district), edit the rect_poly(...) bounds below: migrations re-run on every
-- scraper startup and the seed rows are updated in place (ON CONFLICT). To
-- re-label already-stored rows after a tweak, re-run the backfill UPDATE at
-- the bottom without the "location IS NULL" guard.
--
-- Idempotent; applied automatically by the scraper on startup, or once with:
--   docker exec -i olx-db psql -U olx -d olx < db/init/11-neighborhoods.sql
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS neighborhoods;   -- seeds below fully re-create it; keeps
                                      -- the poly column type authoritative here
CREATE TABLE neighborhoods (
  name     TEXT PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 100,
  poly     DOUBLE PRECISION[] NOT NULL   -- flattened ring: lon1,lat1,lon2,lat2,…
);

-- Closed rectangular ring from bounds, flattened (lon,lat per vertex, first
-- point repeated at the end).
DROP FUNCTION IF EXISTS rect_poly(double precision, double precision, double precision, double precision);
CREATE FUNCTION rect_poly(p_lat_min double precision, p_lat_max double precision,
                          p_lon_min double precision, p_lon_max double precision)
RETURNS double precision[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[p_lon_min, p_lat_min,
               p_lon_max, p_lat_min,
               p_lon_max, p_lat_max,
               p_lon_min, p_lat_max,
               p_lon_min, p_lat_min]
$$;

-- Even-odd ray casting; flattened polygon is lon1,lat1,lon2,lat2,…
DROP FUNCTION IF EXISTS point_in_polygon(double precision, double precision, double precision[]);
DROP FUNCTION IF EXISTS point_in_polygon(double precision, double precision, POINT[]);
CREATE FUNCTION point_in_polygon(p_lat double precision, p_lon double precision,
                                 p_poly double precision[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  verts  integer := COALESCE(array_length(p_poly, 1), 0) / 2;
  px     double precision;
  py     double precision;
  qx     double precision;
  qy     double precision;
  i      integer;
  inside boolean := false;
BEGIN
  IF verts < 3 OR p_lat IS NULL OR p_lon IS NULL THEN
    RETURN false;
  END IF;
  qx := p_poly[(verts - 1) * 2 + 1];
  qy := p_poly[(verts - 1) * 2 + 2];
  FOR i IN 1..verts LOOP
    px := p_poly[(i - 1) * 2 + 1];
    py := p_poly[(i - 1) * 2 + 2];
    IF (py > p_lat) <> (qy > p_lat) THEN
      IF p_lon < (qx - px) * (p_lat - py) / (qy - py) + px THEN
        inside := NOT inside;
      END IF;
    END IF;
    qx := px;
    qy := py;
  END LOOP;
  RETURN inside;
END;
$$;

CREATE OR REPLACE FUNCTION neighborhood_of(p_lat double precision, p_lon double precision)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT n.name
  FROM neighborhoods n
  WHERE point_in_polygon(p_lat, p_lon, n.poly)
  ORDER BY n.priority, n.name
  LIMIT 1
$$;

-- Approximate Banja Luka districts. Bounds are (lat_min, lat_max, lon_min,
-- lon_max) — kept deliberately disjoint so match order never matters.
INSERT INTO neighborhoods (name, priority, poly) VALUES
  ('Centar',             10, rect_poly(44.7670, 44.7765, 17.1820, 17.1970)),
  ('Mejdan',             20, rect_poly(44.7765, 44.7835, 17.1820, 17.1970)),
  ('Borik',              30, rect_poly(44.7730, 44.7840, 17.1570, 17.1820)),
  ('Obilicevo',          40, rect_poly(44.7660, 44.7800, 17.1360, 17.1570)),
  ('Starcevica',         50, rect_poly(44.7500, 44.7645, 17.1640, 17.1900)),
  ('Debeljaca',          60, rect_poly(44.7645, 44.7725, 17.1690, 17.1820)),
  ('Vujanovica potok',   70, rect_poly(44.7540, 44.7645, 17.1900, 17.1970)),
  ('Laus',               80, rect_poly(44.7520, 44.7700, 17.1970, 17.2200)),
  ('Novoselija',         85, rect_poly(44.7700, 44.7745, 17.1970, 17.2240)),
  ('Lazarevo',           90, rect_poly(44.7745, 44.7890, 17.1970, 17.2240)),
  ('Budzak',            100, rect_poly(44.7890, 44.8030, 17.1800, 17.2240)),
  ('Sargovac',          105, rect_poly(44.8030, 44.8250, 17.1900, 17.2240)),
  ('Drakulic',          110, rect_poly(44.7700, 44.7960, 17.0900, 17.1360)),
  ('Petricevac',        120, rect_poly(44.7800, 44.7960, 17.1360, 17.1570)),
  ('Motike',            130, rect_poly(44.7960, 44.8060, 17.1300, 17.1800)),
  ('Zaluzani',          140, rect_poly(44.7380, 44.7550, 17.1450, 17.1640))
ON CONFLICT (name) DO UPDATE SET priority = EXCLUDED.priority, poly = EXCLUDED.poly;

-- Backfill existing rows (pins only). Re-run after polygon tweaks, dropping
-- the location IS NULL guard, to re-label everything from scratch:
UPDATE listings
   SET location = neighborhood_of(latitude, longitude)
 WHERE location IS NULL
   AND latitude IS NOT NULL AND longitude IS NOT NULL;
