'use strict';
// 19-gen-sql.js — regenerate db/init/11-neighborhoods.sql from
// geo/banja-luka-mz-final.geojson (56 official MZ polygons: 19 hand-drawn core
// + 37 traced rural). DB names are ASCII (existing seed convention); display
// names keep diacritics in the GeoJSON.
const fs = require('fs');
const path = require('path');
const GEO = path.join(__dirname, '..');
const ROOT = path.join(GEO, '..');

const fc = JSON.parse(fs.readFileSync(path.join(GEO, 'banja-luka-mz-final.geojson'), 'utf8'));

const DIAC = { 'Š': 'S', 'š': 's', 'Č': 'C', 'č': 'c', 'Ć': 'C', 'ć': 'c',
  'Ž': 'Z', 'ž': 'z', 'Đ': 'D', 'đ': 'd' };
const ascii = s => s.replace(/[ŠšČčĆćŽžĐđ]/g, c => DIAC[c]);

const seen = new Set();
const rows = fc.features.map(f => {
  const name = ascii(f.properties.name);
  if (seen.has(name)) throw new Error(`duplicate ASCII name: ${name}`);
  seen.add(name);
  const flat = f.geometry.coordinates[0]
    .map(([lo, la]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(',');
  return `('${name.replace(/'/g, "''")}', ${String(f.properties.priority).padStart(3)}, ARRAY[${flat}])`;
});

const sql = `-- ─────────────────────────────────────────────────────────────────────────────
-- Neighborhood mapping from map pins.
--
-- listings.location is never populated by olx.ba, but ~99% of listings carry
-- latitude/longitude pins. This migration ships the official Banja Luka MZ
-- (mjesna zajednica) polygons and assigns each pin its neighborhood:
--
--   neighborhoods(name, priority, poly)  — flattened polygon rings (lon,lat pairs)
--   point_in_polygon(lat, lon, poly)     — ray casting, plain plpgsql (no PostGIS)
--   polygon_distance_m(lat, lon, poly)   — point-to-ring distance in meters
--   neighborhood_of(lat, lon)            — containing polygon by priority; pins
--                                          in no polygon fall back to the
--                                          nearest polygon edge within 500 m;
--                                          NULL only beyond that
--
-- Polygons come from the official "Prostorni plan grada Banja Luka" MZ map
-- (scanned, georeferenced and traced — see geo/PROGRESS.md): 19 urban-core MZs
-- digitized by hand over the georeferenced scan, 37 rural MZs auto-traced from
-- the map's MZ layer. Names are ASCII (no diacritics). priority ranks by area
-- (smaller/urban first) so shared-border ties resolve deterministically.
--
-- Idempotent; applied automatically by the scraper on startup, or once with:
--   docker exec -i olx-db psql -U olx_app -d olx < db/init/11-neighborhoods.sql
--   ^ the APP role — never hand-apply as the bootstrap superuser (-U olx):
--     superuser-owned objects broke enrichment ("permission denied for table
--     neighborhoods") and then the instance sync (2026-08-24; see README ·
--     Troubleshooting).
-- To re-label already-stored rows after a tweak, re-run the backfill UPDATE at
-- the bottom WITHOUT the "location IS NULL" guard.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS neighborhoods;   -- seeds below fully re-create it; keeps
                                      -- the poly column type authoritative here
CREATE TABLE neighborhoods (
  name     TEXT PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 100,
  poly     DOUBLE PRECISION[] NOT NULL   -- flattened ring: lon1,lat1,lon2,lat2,…
);

-- legacy rectangle helper from the first seed — dropped so stale installs
-- don't keep it around
DROP FUNCTION IF EXISTS rect_poly(double precision, double precision, double precision, double precision);

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

-- Point-to-ring distance in meters (equirectangular approximation — plenty
-- for a ≤ 5 km fallback decision). Null-safe.
CREATE OR REPLACE FUNCTION polygon_distance_m(p_lat double precision, p_lon double precision,
                                              p_poly double precision[])
RETURNS double precision LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  verts integer := COALESCE(array_length(p_poly, 1), 0) / 2;
  kx    double precision := 111320.0 * cos(radians(p_lat));
  px    double precision := p_lon * kx;
  py    double precision := p_lat * 111320.0;
  best  double precision;
  d     double precision;
  x1    double precision; y1 double precision;
  x2    double precision; y2 double precision;
  dx    double precision; dy double precision;
  t     double precision;
  ex    double precision; ey double precision;
  i     integer;
BEGIN
  IF verts < 3 OR p_lat IS NULL OR p_lon IS NULL THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..verts LOOP
    x1 := p_poly[(i - 1) * 2 + 1] * kx;  y1 := p_poly[(i - 1) * 2 + 2] * 111320.0;
    x2 := p_poly[i * 2 + 1] * kx;        y2 := p_poly[i * 2 + 2] * 111320.0;
    dx := x2 - x1;  dy := y2 - y1;
    IF dx = 0 AND dy = 0 THEN
      t := 0;
    ELSE
      t := ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
      t := GREATEST(0, LEAST(1, t));
    END IF;
    ex := x1 + t * dx - px;  ey := y1 + t * dy - py;
    d := ex * ex + ey * ey;
    IF best IS NULL OR d < best THEN
      best := d;
    END IF;
  END LOOP;
  RETURN CASE WHEN best IS NULL THEN NULL ELSE sqrt(best) END;
END;
$$;

-- Neighborhood of a pin: the containing polygon wins (priority breaks shared-
-- border ties). Hand-traced borders can't be pixel-perfect and the grad is
-- vast, so a pin in no polygon falls back to the NEAREST polygon edge within
-- 5 km — a pin across a seam or in a wide untraced pocket still gets its
-- district. Beyond the tolerance it stays NULL = '(unmapped)'.
CREATE OR REPLACE FUNCTION neighborhood_of(p_lat double precision, p_lon double precision)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
  n_row     RECORD;
  d         double precision;
  best_name TEXT;
  best_dist double precision;
BEGIN
  IF p_lat IS NULL OR p_lon IS NULL THEN
    RETURN NULL;
  END IF;
  FOR n_row IN SELECT name, poly FROM neighborhoods ORDER BY priority, name LOOP
    IF point_in_polygon(p_lat, p_lon, n_row.poly) THEN
      RETURN n_row.name;
    END IF;
  END LOOP;
  FOR n_row IN SELECT name, poly FROM neighborhoods ORDER BY priority, name LOOP
    d := polygon_distance_m(p_lat, p_lon, n_row.poly);
    IF d IS NOT NULL AND (best_dist IS NULL OR d < best_dist) THEN
      best_dist := d;
      best_name := n_row.name;
    END IF;
  END LOOP;
  IF best_dist IS NOT NULL AND best_dist <= 5000 THEN
    RETURN best_name;
  END IF;
  RETURN NULL;
END;
$$;

-- Official Banja Luka MZ polygons (geo/banja-luka-mz-final.geojson).
INSERT INTO neighborhoods (name, priority, poly) VALUES
${rows.join(',\n')}
ON CONFLICT (name) DO UPDATE SET priority = EXCLUDED.priority, poly = EXCLUDED.poly;

-- Backfill existing rows (pins only). Re-run after polygon tweaks, dropping
-- the location IS NULL guard, to re-label everything from scratch:
UPDATE listings
   SET location = neighborhood_of(latitude, longitude)
 WHERE location IS NULL
   AND latitude IS NOT NULL AND longitude IS NOT NULL;
`;

const out = path.join(ROOT, 'db', 'init', '11-neighborhoods.sql');
fs.writeFileSync(out, sql);
console.log(`wrote ${out}: ${rows.length} MZ polygons`);
