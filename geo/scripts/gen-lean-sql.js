"use strict";

// Generate the PostGIS neighborhood seed used by the lean baseline.
const fs = require("fs");
const path = require("path");
const geoDir = path.join(__dirname, "..");
const root = path.join(geoDir, "..");
const featureCollection = JSON.parse(
  fs.readFileSync(path.join(geoDir, "banja-luka-mz-final.geojson"), "utf8"),
);

const diacritics = {
  Š: "S",
  š: "s",
  Č: "C",
  č: "c",
  Ć: "C",
  ć: "c",
  Ž: "Z",
  ž: "z",
  Đ: "D",
  đ: "d",
};
const ascii = (value) =>
  value.replace(/[ŠšČčĆćŽžĐđ]/g, (char) => diacritics[char]);
const seen = new Set();
const rows = featureCollection.features.map((feature) => {
  const name = ascii(feature.properties.name);
  if (seen.has(name)) throw new Error(`duplicate ASCII name: ${name}`);
  seen.add(name);
  const flat = feature.geometry.coordinates[0]
    .map(
      ([longitude, latitude]) =>
        `${longitude.toFixed(6)},${latitude.toFixed(6)}`,
    )
    .join(",");
  return `('${name.replace(/'/g, "''")}', ${String(feature.properties.priority).padStart(3)}, ARRAY[${flat}])`;
});

const sql = `-- Generated from geo/banja-luka-mz-final.geojson; do not edit by hand.
WITH seed(name, priority, poly) AS (
  VALUES ${rows.join(",\n")}
), rings AS (
  SELECT name,
         ST_MakeLine(ARRAY_AGG(
           ST_SetSRID(ST_MakePoint(poly[i], poly[i + 1]), 4326)
           ORDER BY i
         )) AS ring
    FROM seed
   CROSS JOIN LATERAL generate_series(1, cardinality(poly) - 1, 2) AS i
   GROUP BY name
)
INSERT INTO lean.neighborhoods (name, boundary)
SELECT s.name, ST_Multi(ST_MakePolygon(r.ring))
  FROM seed s JOIN rings r USING (name)
ON CONFLICT (name) DO UPDATE SET boundary = EXCLUDED.boundary;

DO $$
BEGIN
  IF (SELECT count(*) FROM lean.neighborhoods) <> 56
     OR EXISTS (SELECT 1 FROM lean.neighborhoods
                 WHERE ST_IsEmpty(boundary) OR NOT ST_IsValid(boundary)) THEN
    RAISE EXCEPTION 'lean neighborhood seed failed validation';
  END IF;
END $$;
`;

const outputPath = path.join(
  root,
  "db",
  "init-lean",
  "02-lean-neighborhoods.sql",
);
fs.writeFileSync(outputPath, sql);
console.log(`wrote ${outputPath}: ${rows.length} MZ polygons`);
