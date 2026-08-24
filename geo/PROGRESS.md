# MZ boundary tracing — progress handoff

Working notes for the task "trace official MZ (mjesna zajednica) boundary polygons from the
scanned PDF onto WGS84 lon/lat, eventually replacing the rough rectangles in
`db/init/11-neighborhoods.sql`". Written so a fresh session can pick up without re-deriving
anything. Update the transcription table + checklists as you go.

---

## 0. CURRENT STATE — COMPLETE (2026-08-24 session)

**The MZ polygon set shipped: `db/init/11-neighborhoods.sql` now seeds 56 official MZ
polygons (replacing the old rectangles+OSM-mix seed), is applied to the live `olx-db`,
and all tests are green.**

- Inputs: the user hand-drew the 19-polygon urban core in `geo/editor.html` → saved as
  `geo/city-core.geojson`; the 37 rural MZs come from the auto-traced
  `geo/banja-luka-mz.geojson`. Traced regions mostly inside a hand-drawn polygon were
  absorbed (14: #17,19,20,21,23,26,27,29,30,32,34,35,36,40 — #29 via collective
  coverage, the user split it into Laus 1 + Kocicev Vijenac + Pobrdje).
- Merge/validate: `geo/scripts/13-merge.js` → `geo/banja-luka-mz-final.geojson`
  (56 features: `name`, `source` manual-digitized|trace, `mz_id` for traced ones,
  `priority` = area rank smaller-first, CCW RFC7946 rings, 6 dp). Built-in checks:
  absorption fractions, Trg Krajine pin → `Centar 2`, spot pins, pairwise overlap
  sampling (only edge slivers, ≤ ~6% of tiny shared bboxes).
- Visual verification: `geo/scripts/14-verify-render.js` → `debug/final-tile-1..6.jpg`
  (cyan = hand-drawn, orange = traced, drawn over the warped scan). Boundaries follow
  the map's red MZ lines; map legend confirms the yellow layer IS the MZ layer.
- Name verification: `geo/scripts/18-labelsheet2.js` (2×2 hi-res sheets) +
  `15-labelzoom.js` / `16-cropat.js` single crops. Four earlier ls-sheet misreads
  corrected: **#2 Верићи (Verići, not "Vrćani"), #46 Љубачево (Ljubačevo, not
  Ljubićevo), #47 Крмине (Krmine, not "Krmiš"), #49 Стричићи (Stričići, not
  "Sugrišići")**. Also settled: #37 = Српске Топлице (the old "Обилићево 2 = #37"
  guess was wrong; the user's single "Obilicevo" polygon merges Обилићево 1+2),
  #40 = unlabeled sliver absorbed by drawn Starcevica (98%), "Лебљаца" was a misread
  (that area is Ада west of the boundary, Врбања east of it).
- SQL generation: `geo/scripts/19-gen-sql.js` → `db/init/11-neighborhoods.sql`
  (ASCII names per seed convention; same schema + point_in_polygon/neighborhood_of;
  legacy `rect_poly` helper dropped; priorities = area rank). Regenerate from the
  GeoJSON after any polygon edit.
- Applied live: seed re-applied (`INSERT 0 56`) + backfill UPDATE run **unguarded** →
  all 1,367 pinned listings carry MZ names (Centar 1 ×277, Starcevica ×112,
  Centar 2 ×93, …; 100 out-of-city pins = NULL/unmapped).
- Tests: `npm run test:integration` **37/37 green**, unit **25/25**.
  `scraper/test/integration/db-details.test.js` updated: Trg Krajine pin
  (44.7725, 17.1905) → **`Centar 2`** (both the direct and the first-wins assert).
- **Follow-up for dashboards:** legacy district names (Centar, Laus, Mejdan, Budzak,
  Novoselija, Vujanovica potok, Debeljaca, Borik, Lazarevo…) no longer occur in
  `listings.location` — Grafana variables/panels that hardcode district lists must
  switch to the 56 MZ names (see `SELECT name FROM neighborhoods ORDER BY priority`).

## 1. Goal

- Source: `1-2_Teritorija_i_granice_NM_i_MZ.pdf` (Prostorni plan grada Banja Luke, list 1-2 —
  "Teritorija i granice NM i MZ", official city map of naseljena mjesta / mjesne zajednice;
  1:50 000, Institut za građevinarstvo IG d.o.o., March 2014).
- Output: polygons (lon,lat), `properties.name` (Latin script) — final consumer
  `db/init/11-neighborhoods.sql` (§8).

## 2. Layout / artifact inventory (all under `geo/`)

| Path | Size | What it is |
|---|---|---|
| `pdf-pages/page-1.png` | 33 MB | Scan rasterized at 150 dpi, **4967×7021 px** (Docker poppler). The only scan input. |
| `pdf-pages/overview.jpg` | 3.3 MB | Whole-page overview. |
| `osm/query.txt` | — | Overpass query: `relation(2528156); out geom;` (Grad Banja Luka admin boundary). |
| `osm/grad-banjaluka.json` | 627 KB | Overpass response used as registration target. |
| `osm/candidates.json` | 2 KB | Earlier boundary-relation candidates. |
| `debug/regions.json` | 8.6 KB | 52 connected components (51 MZ regions + **id 52 = legend swatch**, `cy≈6828`; everything filters it out via `cy > 6600`). Scan W/H + per-region bbox/centroid. |
| `debug/regions-pixel.json` | 83 KB | Simplified outer ring per region in **full-res scan pixel coords** (input to 04-georef). |
| `debug/red-mask.png`, `yellow-mask.png`, `regions.png` | ~65–90 KB | Debug renders of classification/segmentation (downscaled ≤1400 px). |
| `debug/transform.json` | — | Fitted affine + ICP stats (see §6). |
| `debug/labels-1..9.png` | 1.7–3.2 MB | Old contact sheets (06-labels.js, centroid crops) — superseded by names-*. |
| `debug/names-1..7.png` | 0.4–0.9 MB | **07-namecrops.js** contact sheets, 2×4 cells, cells ordered by ascending region id. |
| `debug/names-1..7.jpg` | 78–178 KB | ffmpeg re-encodes of the above (the PNGs are too big / wrong format for the viewer). |
| `debug/check.png` / `check.jpg` | 3.4 MB / 1.1 MB | 05-render.js registration overlay (grayscale scan + traced rings red + OSM boundary mapped back through inverse affine in blue). **Not yet visually verified.** |
| `debug/checks.jpg` | 275 KB | Scaled-down check overlay — **still above the ~165 KB viewer limit, needs another downscale pass before reading.** |
| `debug/check2/3/4.jpg` | 1–3 MB | Earlier check renders/attempt variants. |
| `banja-luka-mz.geojson` | 153 KB | Current output of 04-georef.js — 51 features, names still missing (`"MZ <id>"` placeholders). |

Note: `geo/README.md` mentions a `tiles/` dir of OSM tiles — it does **not** exist yet;
georeferencing so far used the Overpass boundary only. Tile-backed validation render is a TODO.

## 3. Pipeline scripts (`geo/scripts/`, plain Node CommonJS, deps: pngjs + jimp)

Run with `cd geo/scripts && node NN-*.js`. `common.js` holds shared machinery.

| Script | Purpose / output |
|---|---|
| `common.js` | `loadScan()` reads `geo/pdf-pages/page-1.png`; `classify()` → red mask (boundaries/labels: `r>110 && r-g>45 && r-b>45`) + yellow mask (MZ fill), red wins; `erode/dilate` (square, separable); `connectedComponents` (4-conn, compact ids); `saveDebugPng` (≤1400 px). |
| `01-masks.js` | Mask debug PNGs + histogram (threshold tuning aid). |
| `02-regions.js` | Yellow fill minus dilated-red(2px) → connected components ≥4000 px → `debug/regions.json` + colored `regions.png`. |
| `03-trace.js` | Per-region outer boundary by crack following (interior on right), Douglas-Peucker simplification `EPS=2.0` px → `debug/regions-pixel.json`. |
| `04-georef.js` | Union of all regions dilated 5 px ≈ red city-boundary centerline → outer outline → **ICP affine fit** against OSM boundary (points resampled every ~60 m; initial rotation swept −2°..+2° step 0.5°). Applies affine to every ring, enforces CCW + closing point, writes `banja-luka-mz.geojson` + `debug/transform.json`. **Reads optional `geo/scripts/names.json`** (`{ "regionId": "Latin name" }`, fallback `"MZ <id>"`) — the integration point for transcriptions. |
| `05-render.js` | Pixel-space registration overlay → `debug/check.png`. |
| `06-labels.js` | Old centroid-based label crops (`labels-*.png`) — superseded. |
| `07-namecrops.js` | Current label-crop sheets `debug/names-*.png`: red-mask connected components of 150–25000 px (boundary network is one huge component, MZ labels are small isolated ones); each label component assigned to the region whose yellow component dominates a ±8 px (step 4) **ring sampled around each glyph pixel** — see gotcha below. Union bbox per region → crop with 22 px pad, `#id` drawn per cell. |
| `draw.js` | Bitmap text for debug sheets. |
| `geo-icp.js` | `evalInit` (rotation sweep) + `fitAffineICP`. |
| `tojpg.js` | `node tojpg.js a.png …` → Jimp q70 .jpg next to each (host-side alternative to ffmpeg). |

## 4. Environment gotchas (burned us once each — don't repeat)

1. **ImageMagick in the alpine container silently writes PNG bytes into `.jpg` files**
   (no JPEG delegate). All "jpg" debug images made with `convert` were PNGs and the viewer
   rejected/blanked them. **Use ffmpeg instead:**
   `ffmpeg -i x.png -q:v 7 x.jpg` and, when still too big, `ffmpeg -i x.png -vf scale=800:-1 -q:v 8 x.jpg`.
2. **Viewer rejects debug images ≳165 KB** (borderline: names-1 at 177 KB and names-2 at
   168 KB did display; names-3 at 160 KB once didn't). Keep sheets < ~160 KB or downscale.
3. **Multi-image `read_files` calls only surface the first image** — read debug images
   strictly one file per message, retry if the result comes back without the image.
4. **Red-glyph label bug (fixed in 07-namecrops.js):** MZ name labels are red glyphs on
   yellow fill, so `labels[]` (the yellow component map) is 0 *at* the glyph pixels.
   Matching must sample the *surrounding* yellow in a ring (±8 px, step 4) around each red
   component pixel, then take the majority region (≥60% of votes).
5. Legend swatch is a real yellow component (id 52, `cy≈6828`) — always exclude `cy > 6600`.

## 5. Name transcription status

Sheets are filled in ascending region-id order, 8 cells per sheet:
names-1 → #1–8, names-2 → #9–16, names-3 → #17–24, names-4 → #25–32, names-5 → #33–40,
names-6 → #41–48, names-7 → #49–51 (half empty). 50/51 regions have exact label crops;
**only #40 fell back to a centroid crop** (its label component wasn't matched).

| # | Name (Latin) | Source | Confidence |
|---|---|---|---|
| 1 | Šimani | names-1 | ok |
| 2 | Vrćani | names-1 | ok |
| 3 | Potkozarje | names-1 | ok |
| 4 | Mišin Han | names-1 | ok |
| 5 | Prijakovci | names-1 | ok |
| 6 | Piskavica | names-1 | ok |
| 7 | Dragočaj | names-1 | ok |
| 8 | Gornja Piskavica | names-1 | ok |
| 9 | Kuljani | names-2 | ok |
| 10 | Zalužani | names-2 | ok |
| 11 | Borkovići | names-2 | ok (red label "Борковићи"; the gray "Сливљанка" in the crop is a nearby toponym, not the MZ label) |
| 12 | Bistrica | names-2 | ok |
| 13 | Priječani | names-2 | **verify** (glyph could read "Пријевчани"; Priječani is the real settlement) |
| 14 | Saračica? | names-2 | **verify** (read "Сарачица" off a downscaled JPEG; not a name I can confirm) |
| 15 | Šargovac | names-2 | ok |
| 16 | Motike | names-2 | ok |
| 17–24 | — | names-3 | **re-read**: names-3 was viewed in an earlier session but its transcription was never written down |
| 25–32 | — | names-4 | unread (names-4.jpg is 153 KB, should display) |
| 33–40 | — | names-5 | unread (names-5.jpg is 164 KB — borderline; rescale if rejected). #40 is the centroid-fallback crop |
| 41–48 | — | names-6 | unread (154 KB) |
| 49–51 | — | names-7 | unread (78 KB, half-empty sheet) |

## 6. Georeferencing status — FIXED, verified

The original ICP transform was a **vertically-flipped false minimum**: `evalInit` bbox-aligned
with positive y-scale only (south-up init for a north-up scan), and the reported "mean 110 m"
was computed over the ICP's *inlier subset only* — the honest residual was median 1130 m,
max 6.8 km (urban core off by ~9 km; Drakulić's label 13 km off).

**Fix (geo-icp.js / 04-georef.js):** `evalInit` now takes `{flipY,flipX}`; the init sweep
tries all 4 orientations × rotations −2°..+2°. `fitAffineICP` reports honest all-point stats
(`stats.all`). The `flipY=1` init wins decisively and ICP converges to:
- **all 10051 outline points: mean 27.5 m, median 23.6 m, p90 48.4 m, max 260.6 m**
- scale ≈ 9.50×9.47 m/px, rotation +0.62°; scan is north-up (readable text).
Independent checks: `check-fit.js` (OSM boundary → transformed rings: median 85 m),
`check-orient.js` (N/S tips + Trg Krajine land correctly). OSM relation 2528156 =
Grad Banja Luka, admin_level 6 (verified via API); bbox 16.7925–17.3030 / 44.4900–44.9878.

## 7. Label/segmentation findings (why manual digitizing won)

- `07-namecrops.js` ring-vote assignment misassigns labels near borders (region 18's sheet
  crop showed "Старчевица" while the region is actually Стратинска).
- Big red MZ labels seal the yellow fill and SPLIT one MZ into two components —
  **user confirmed: regions 21+26 are both Росуље (Rosulje)**.
- Urban fabric (streets/buildings) is uncolored in the yellow mask → white gaps.
- `segment.js` (buildSegments) implements label-bridge + gap-fill + legacy-id-stable
  remapping; works (48 regions, 21+26 merged) but junction labels make some merges
  ambiguous — paused in favor of manual digitizing.
- **Confirmed map-label readings** (from `debug/ls-*.png` centroid sheets + regionmaps):
  1 Šimani, 2 Vrćani, 3 Potkozarje, 4 Mišin Han, 5 Prijakovci, 6 Piskavica, 7 Dragočaj,
  8 Gornja Piskavica, 9 Kuljani, 10 Zalužani, 11 Borkovići, 12 Bistrica, 13 Priječani,
  14 Saračica, 15 Šargovac, 16 Motike, 18 Stratinska, 20 Drakulić, 21+26 Rosulje (one MZ),
  22 Bronzani Majdan, 24 Čokori; urban map also shows: Лазарево 1/2 (#19/#17), Центар 1/2,
  Борик 1/2, Нова Варош, Лауш 1/2, Петрићевац, Паприковац, Побрђе, Кочићев вијенац,
  Обилићево 1/2 (#36/#37), Старчевица, Ада, Булевар, Чесма, Врбања (#31), Дебељаци (#38),
  Српске Топлице, Росуље. OSM place-node cross-check: `osm/places.json` (323 nodes),
  `match-places.js` prints per-region candidates. Wikipedia confirms Сарачица, Центар I/II,
  Лазарево 1/2, Поткозарје (×2), Карановац (Јагаре+Бастаси), Ада, Побрђе, Чесма, Нова варош,
  Росуље (парк Младен Стојановић), Доња Кола (neighbors: Голеши, Кола, Сарачица,
  Чокорска поља).
- **High-res re-verification (18-labelsheet2.js, 2026-08-24) corrected four readings:**
  #2 Верићи (Verići, not "Vrćani"), #46 Љубачево (Ljubačevo, not Ljubićevo),
  #47 Крмине (Krmine, not "Krmiš"), #49 Стричићи (Stričići, not "Sugrišići"); also
  confirmed #37 Српске Топлице (not Обилићево 2) and the Rekavice 1/2 digits.
  Final mapping: `13-merge.js` NAMES + `banja-luka-mz-final.geojson`.

## 8. Integration target: `db/init/11-neighborhoods.sql`

- Schema: `neighborhoods(name TEXT PRIMARY KEY, priority INT DEFAULT 100, poly)` — `poly` is a
  **flattened array of lon,lat pairs** (one exterior ring, no PostGIS).
- `point_in_polygon(lat, lon, poly)` = plain-plpgsql ray casting; `neighborhood_of(lat, lon)`
  picks the **first matching polygon ordered by `priority, name`** — the current rectangles are
  deliberately disjoint so order never matters; real MZ polygons tile the city, so priorities
  must be set so shared-border ties resolve deterministically (e.g. smaller/urban MZs first).
- Backfill: `UPDATE listings SET location = neighborhood_of(latitude, longitude) WHERE location
  IS NULL …`; scraper does `location = COALESCE(location, neighborhood_of($2,$3))` (first-wins)
  in `scraper/src/db.js` `enrichListings`.
- Apply with `docker exec -i olx-db psql -U olx_app -d olx < db/init/11-neighborhoods.sql`
  — the APP role, never the bootstrap superuser (`-U olx` cost us the 2026-08-24
  enrichment + sync outage; see README troubleshooting).
- **Test to keep green:** `scraper/test/integration/db-details.test.js` seeds a pin at
  (44.7725, 17.1905) ("Trg Krajine area") and expects `Centar` — whatever polygons ship must
  still contain that point for a polygon named `Centar` (or the test must be updated).
- `db/init/12-neighborhood-filter.sql` + Grafana filters consume `listings.location` values,
  so renaming districts changes filter options — decide whether to keep legacy rectangle names
  as aliases or switch dashboards to official MZ names.
- **DONE 2026-08-24:** seed replaced via `19-gen-sql.js` (from `banja-luka-mz-final.geojson`),
  applied to `olx-db`, backfill re-run unguarded (1,367 pinned rows re-labeled);
  `db-details.test.js` expects `Centar 2`; integration 37/37 + unit 25/25 green.
  Dashboard district lists still need migrating to the MZ names (no aliases kept).




