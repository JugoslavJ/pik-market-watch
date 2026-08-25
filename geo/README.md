# Georeferenced MZ boundaries for Grad Banja Luka

Traced from `1-2_Teritorija_i_granice_NM_i_MZ.pdf` (official city map of
naseljena mjesta / mjesne zajednice) onto WGS84 lon/lat.

Layout:

- `pdf-pages/`   – rasterized PDF pages (Docker poppler, 150 dpi)
- `osm/`         – Overpass queries/responses used for georeferencing
- `debug/`       – masks, crops and renders produced along the way
- `scripts/`     – post-trace tooling: merge, topology sweep/repair, SQL seed
                   generation
- `banja-luka-mz.geojson` – raw auto-traced rural polygons (lon,lat)
- `banja-luka-mz-final.geojson` – merged, repaired 56-MZ set shipped to the DB
- `city-core.geojson` – hand-drawn urban core (merged in + dashboard filter)
