# Banja Luka MZ geography

This directory contains the source data and reproducible tooling for the Banja Luka mjesne zajednice (MZ) seed used by PostgreSQL neighborhood assignment.

| Path | Purpose |
|---|---|
| `banja-luka-mz.geojson` | Traced boundary input outside the city core. |
| `city-core.geojson` | Hand-drawn city-core boundary input. |
| `banja-luka-mz-final.geojson` | Final merged polygon source. |
| `scripts/merge.js` | Merges the two source sets into the final GeoJSON. |
| `scripts/sweep.js` | Reports overlaps, seams, holes, and optional pin distances. |
| `scripts/repair.js` | Raster-repairs a GeoJSON in place; use only on a copy while reviewing geometry changes. |
| `scripts/gen-sql.js` | Generates `../db/init/11-neighborhoods.sql` from the final GeoJSON. |
| `osm/` | Overpass queries and responses used while naming/georeferencing the trace. |

Coordinates are WGS84 `[longitude, latitude]`. Polygon rings are closed and counter-clockwise in GeoJSON. The seed stores flattened longitude/latitude pairs and uses ray casting; its 5 km nearest-polygon fallback is intended to handle pins just outside a traced boundary, not to establish legal boundaries.

## Regenerate the seed

Run these commands from `geo/scripts` with Node installed:

```bash
node merge.js
node sweep.js ../banja-luka-mz-final.geojson
node gen-sql.js
```

`merge.js` rewrites the final GeoJSON and `gen-sql.js` rewrites the generated SQL, so review both changes. If using `repair.js`, copy the target GeoJSON first, run the repair on that copy, inspect it with `sweep.js`, and only then replace the final source and regenerate SQL. Do not hand-edit `db/init/11-neighborhoods.sql`.

See [DATA.md](../DATA.md) for source attribution and licensing constraints.
