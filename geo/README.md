# Banja Luka MZ geography

Source boundaries and tools for the Banja Luka mjesne zajednice (MZ) neighborhood seed.

| Path | Purpose |
|---|---|
| `banja-luka-mz.geojson` | Traced boundary input outside the city core. |
| `city-core.geojson` | Hand-drawn city-core boundary input. |
| `banja-luka-mz-final.geojson` | Final merged polygon source. |
| `scripts/merge.js` | Merges the two source sets into the final GeoJSON. |
| `scripts/sweep.js` | Reports overlaps, seams, holes, and optional pin distances. |
| `scripts/repair.js` | Raster-repairs a GeoJSON in place; use only on a copy while reviewing geometry changes. |
| `scripts/gen-lean-sql.js` | Generates `../db/init-lean/02-lean-neighborhoods.sql` from the final GeoJSON. |
| `osm/` | Overpass queries and responses used while naming/georeferencing the trace. |

Coordinates are WGS84 `[longitude, latitude]`, with closed counter-clockwise rings. PostGIS assigns listings by containment, then by the nearest boundary within 5 km. These are approximate neighborhood boundaries.

## Regenerate the seed

Run these commands from `geo/scripts` with Node installed:

```bash
node merge.js
node sweep.js ../banja-luka-mz-final.geojson
node gen-lean-sql.js
```

`merge.js` rewrites the final GeoJSON and `gen-lean-sql.js` rewrites the generated SQL, so review both changes. If using `repair.js`, copy the target GeoJSON first, run the repair on that copy, inspect it with `sweep.js`, and only then replace the final source and regenerate SQL. Applied SQL baselines are checksum protected. For a database already initialized, ship boundary updates in a new ordered SQL migration rather than changing an applied seed.

See [DATA.md](../DATA.md) for source attribution and licensing constraints.
