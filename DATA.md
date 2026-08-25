# Data provenance & licensing

The AGPLv3 `LICENSE` covers this repository's **code** (scraper, SQL schema,
scripts, dashboard JSON). The committed **geographic data** artifacts have
their own origin story and are called out here so redistribution decisions
are informed ones:

| Artifact | Origin | Notes |
|---|---|---|
| `db/init/11-neighborhoods.sql`, `geo/banja-luka-mz.geojson`, `geo/banja-luka-mz-final.geojson` | 56 official Banja Luka *mesne zajednice* (MZ) polygons, hand-digitized from the city's official MZ boundary map | The city publishes no explicit open-data license for that map; traced here for personal analysis. If you redistribute, do so at your own discretion and attribute the City of Banja Luka as the underlying source. 2026-08-25: the shipped final set was grid-normalized (`geo/scripts/21-mz-repair.js`) — overlaps resolved, seams ≤ 160 m closed, 12 m simplification — so it differs slightly from the raw trace (raw trace in git history). |
| `geo/osm/*.json`, `*.txt` | OpenStreetMap via Overpass API queries | © OpenStreetMap contributors, ODbL 1.0. Derived works may trigger ODbL share-alike/attribution obligations independent of this repo's license. |
| `geo/city-core.geojson` | Hand-drawn dashboard filter polygon | Same terms as the code. |

Everything else in the repo is original work under AGPLv3.
