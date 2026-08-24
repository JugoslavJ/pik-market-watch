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
--   neighborhood_of(lat, lon)            — first matching polygon by priority,
--                                          NULL when no district matches
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

CREATE OR REPLACE FUNCTION neighborhood_of(p_lat double precision, p_lon double precision)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT n.name
  FROM neighborhoods n
  WHERE point_in_polygon(p_lat, p_lon, n.poly)
  ORDER BY n.priority, n.name
  LIMIT 1
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
