# Data provenance & licensing

AGPLv3 covers the repo's code (scraper, SQL schema, scripts, dashboard JSON).
The committed geographic data has separate origins:

| Artifact | Origin | Notes |
|---|---|---|
| `db/init/11-neighborhoods.sql`, `geo/banja-luka-mz*.geojson` | 56 official Banja Luka *mesne zajednice* (MZ) polygons, hand-digitized from the city's official MZ boundary map | No open-data license published by the city; traced here for personal analysis. Attribute the City of Banja Luka if you redistribute. The shipped set was grid-normalized on 2026-08-25 (`geo/scripts/repair.js`: overlaps resolved, seams ≤ 160 m closed, 12 m simplification), so it differs slightly from the unrepaired auto-traced set (`geo/banja-luka-mz.geojson`). |
| `geo/osm/*.json`, `*.txt` | OpenStreetMap via Overpass API queries | © OpenStreetMap contributors, ODbL 1.0. Derived works may trigger ODbL share-alike/attribution obligations independent of this repo's license. |
| `geo/city-core.geojson` | Hand-drawn dashboard filter polygon | Same terms as the code. |

Everything else in the repo is original work under AGPLv3.
