# Georeferenced MZ boundaries for Grad Banja Luka

Traced from `1-2_Teritorija_i_granice_NM_i_MZ.pdf` (official city map of
naseljena mjesta / mjesne zajednice) onto WGS84 lon/lat.

Layout:

- `pdf-pages/`   – rasterized PDF pages (Docker poppler, 150 dpi)
- `tiles/`       – OpenStreetMap tiles used as georeferencing backdrop
- `scripts/`     – tooling (georeference, trace, render previews)
- `banja-luka-mz.geojson` – final polygons (lon,lat), FeatureCollection
