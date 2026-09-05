# Data provenance and licensing

The repository’s code, SQL, scripts, and dashboard definitions are licensed under AGPLv3. The geographic inputs below have separate provenance and may carry additional attribution or share-alike obligations.

| Artifact | Origin | Use and attribution |
|---|---|---|
| `geo/banja-luka-mz.geojson`, `geo/city-core.geojson`, `geo/banja-luka-mz-final.geojson`, and generated `db/init/11-neighborhoods.sql` | Banja Luka mjesne zajednice (MZ) boundaries traced from the city’s official map | The city map has no identified open-data licence in this repository. Use for personal analysis with attribution to the City of Banja Luka; obtain suitable permission before wider redistribution. |
| `geo/osm/*.json` and `geo/osm/*.txt` | OpenStreetMap contributors, retrieved through the included Overpass queries | © OpenStreetMap contributors, ODbL 1.0. Derived-database, attribution, and share-alike obligations may apply independently of AGPLv3. |

The final GeoJSON is the source used to generate the database seed. It combines the hand-drawn city core with traced boundaries and is normalized by the checked-in geography tools. See [geo/README.md](geo/README.md) for the reproducible workflow. The data is intended for approximate neighborhood assignment from listing map pins; it is not an authoritative cadastral boundary dataset.
