# Architecture & data model

How the tracker stores what it sees, how listings age out, and what the Grafana panels chart.
## Database schema

| Table | Contents |
|---|---|
| `listings` | One row per article: title, url, sqm, rooms, price, ppm², is_rent, first/last seen, `published_at` (day created) and `renewed_at` (day renewed). Ads gone from every search are closed automatically (`closed_at` + frozen `closing_price`/`closing_ppm2`/`closing_category`). Detail data adds `seller_type`, characteristics (rooms/bath/floor/heating/furnished/condition/parking/garage/elevator/year/orientation/plot m²), `views`/`favorites`, raw `characteristics` JSONB, plus raw API extras (`api_status`, `api_price_history`) |
| `price_history` | Append-only snapshots; a row is added only when price/ppm² actually changed |
| `saved_searches` | Watched searches + per-run stats (count, median ppm², new/drop counts) + free-form `category` label for the dashboard filter |
| `search_results` | Which articles each search returned (refreshed every run) |
| `scrape_runs` | Run observability: status, pages, cards, error |
| `neighborhoods` | 56 official Banja Luka MZ (mjesna zajednica) polygons as flattened lon/lat rings; `neighborhood_of(lat, lon)` ray-casts a pin to the MZ name (smaller-area-first priority breaks shared-border ties) and falls back to the nearest MZ within 5 km so pins in digitization seams or grad hamlets without their own traced MZ still get a district; stored into `listings.location` on enrichment. Polygons come from the city's official MZ map — the Prostorni plan scan, georeferenced and traced, then grid-normalized (overlaps removed, seams closed — `geo/scripts/20-mz-sweep.js` / `21-mz-repair.js`); the urban core was digitized by hand (see `geo/PROGRESS.md`). Seeds re-applied on every startup — tweak in `db/init/11-neighborhoods.sql` (or regenerate it from `geo/banja-luka-mz-final.geojson` via `geo/scripts/19-gen-sql.js`), then re-run its backfill UPDATE unguarded to re-label stored rows |
| `v_active_listings` | View: anything seen by a scrape within 14 days |
| `v_listing_lifecycle` | View: one row per listing — opening vs closing price/ppm², change count, days listed, category |
| `v_market_daily` | View: per-day new/closed counts and estimated live inventory |

Schema migrations live in `db/init/*.sql` and are applied in filename order. The Postgres entrypoint runs them on **first** volume start, and the scraper re-checks and applies any *unapplied* ones on every startup — tracked in a `schema_migrations` table. To change the schema later, drop a new **idempotent** migration file into `db/init/` and restart the scraper (`docker compose restart scraper`) — nothing else to do.

Manual application still works if you ever need it:

```bash
docker exec -i olx-db psql -U olx -d olx < db/init/03-listing-filters.sql   # dashboard filter functions
```

### Listing lifecycle

Every scraping cycle ends with a closing pass: any listing that none of the configured searches returned anymore gets `closed_at` set, freezing its last observed price into `closing_price` / `closing_ppm2`. The category of the last search that still returned the ad is frozen into `closing_category`, so closed ads remain filterable even though their `search_results` links are gone. Closed ads drop out of every dashboard panel immediately but stay in `listings` for later analysis. If an ad reappears on olx.ba it reopens automatically on its next sighting (all closing values cleared). A failed scrape never causes closures — its stale result links keep that search's listings open until a successful run sees them gone.

### Detail-page data (attributes beyond the search card)

Search results already carry map pins, m²/rooms labels, the renewal timestamp and the seller type; anything beyond that comes from the ad's JSON endpoint (`/api/listings/<id>` — see `05-listing-details.sql` / `07-api-extras.sql` and `parseListingDetail()`):

- **Day created vs day renewed** — the ad endpoint's `created_at` is the true original publish time and lands in `published_at` (first-wins); the renewal bump (`date`, also on every search card) lands in `renewed_at` (10-listing-dates.sql) and is refreshed monotonically on every scrape cycle, no detail call needed. Days-on-market uses creation; staleness views use both. Legacy rows whose `published_at` was seeded from a renewal stamp before the split stay lower-bound estimates.
- **Neighborhood** — `location` is derived from the ad's map pin via `neighborhood_of()` (`11-neighborhoods.sql`): ray casting over the 56 official Banja Luka MZ polygons (Centar 1/2, Borik 1/2, Obilicevo, Starcevica, Rosulje, Petricevac, … — traced/digitized from the city's official MZ map, ASCII names). NULL when the pin falls outside every MZ (outlying pins); first-wins on enrichment, backfilled for existing rows.
- **Seller type** — `shop` vs `private`, straight from `user.type`.
- **Characteristics** — rooms, bathrooms, floor / total floors / unit levels, heating, furnished, condition, parking, garage, elevator, year built, plot m², orientation. Every `attr_code:value` pair the payload exposes is also kept raw in the `characteristics` JSONB column, so nothing is lost if OLX renames codes.
- **Counters & extras** — views, favorites when exposed, plus the ad's server-side price history and lifecycle status stored raw (`api_price_history` / `api_status`) for cross-checking our own observations.

Detail calls are budgeted per run (`MAX_GEO_FETCHES`) and made only for facts still missing, so steady-state cycles need almost none. Scalar columns are **first-wins** (a renewal date can never overwrite an earlier publish date) while the JSONB map merges on every fetch; `renewed_at` is the one exception — it moves forward monotonically (`GREATEST`) because search cards refresh it every cycle. Backfill existing rows anytime with:

```bash
docker compose run --rm scraper node src/backfill-geo.js             # active listings
docker compose run --rm scraper node src/backfill-geo.js --all       # everything, resumable
```

---
## Dashboards

Four provisioned dashboards live in the **OLX** folder (one JSON file each in `grafana/dashboards/`). The two market dashboards share the same filter bar — Category, Deal, Rooms, m² range, Neighborhood (multi-select, with `(unmapped)` / `(no pin)` buckets) — and **every panel honours both those filters and the dashboard time picker**. All four cross-link via the dashboard links in the top bar, and failed scrape runs are drawn as red region annotations on the market time series so scraper downtime explains any dip or gap.

### OLX.ba Home (`olx-home`)

The landing page — no filter bar, whole database only: six market KPIs (active listings, median sale KM/m², median rent, gross yield, sell-through 30 d, weekly Δ% of the median), three pipeline KPIs (age of the last successful scrape, failed runs 24 h, cards scraped 24 h) and two trend charts (inventory flow, weekly sell-through). Everything links onward to the detail dashboards.

### OLX.ba Market Overview (`olx-overview`)

The daily driver: what is on the market right now.

1. **Headline stats** — active listings, new in 7 d, listings with a price drop in 7 d, median asking KM/m² (sales), median rent KM/mo; all respect the Deal filter
2. **Price trend** — median asking KM/m² over daily snapshots with a p25–p75 band
3. **Market flow** — new vs closed per day with estimated live inventory (`v_market_daily`, whole database) and the stalest still-active listings (oldest creation day first, with the seller's last renewal day)
4. **Map** — pinned listings + linked table
5. **Shopping list** — best-value sales (lowest KM/m²) and recent price drops
6. **Segments & demand** — actives that cut their price + median biggest cut, median KM/m² by rooms, asking KM/m² by condition, neighborhood breakdown from map pins (Obilicevo, Starcevica, Laus, Lazarevo, Budzak, Centar, Borik, …), most-viewed active listings (`views` from ad pages)
7. **Investment view** — gross rental yield (median rent × 12 ÷ median sale price), this-week-vs-last median KM/m² stat, price-vs-m² scatter with a least-squares fit line (genuine bargains sit below it), median KM/m² by floor position (labels carry `n=`; coverage still partial), asking KM/m² by seller type (private vs agency)
8. **Neighborhood economics** — districts ranked by median asking KM/m² with p25–p75 spread (≥ 8 listings each; ignores the Neighborhood filter on purpose so districts stay comparable)

### OLX.ba Exits & Price Endings (`olx-exits`)

Everything about ads that disappeared, i.e. the closest thing olx.ba offers to sold prices. **Exit prices are last *asking* prices observed before removal — not transaction prices.**

1. **Headline stats** — closed listings (30 d), median exit KM/m², sell-through rate (30 d), median days on market for closed ads
2. **Exit prices vs market** — exit vs asking daily medians side by side (the gap is the softening signal) and a days-on-market distribution
3. **Recently closed table** — exit price vs original ask, change % (colour-coded), days listed
4. **Exits by room count**, **exit map** + linked table
5. **Exit dynamics** — exit-discount buckets (final ask vs original ask) and a weekly sell-through-rate trend (`v_market_daily`, whole database)
6. **Liquidity deep dive** — days-on-market vs exit-discount scatter (do stale ads exit cheaper?), exit rate by KM/m² quartile, and exit rate by neighborhood over 30 d (which districts actually move)

### OLX Scraper Health (`olx-health`)

Operational view of the scraper itself — market filters don't apply here.

1. **Headline stats** — searches watched, failed runs (24 h), success rate (24 h), age of the last successful scrape, cards scraped (24 h)
2. **Throughput** — runs per hour stacked ok/error, plus hourly average cards/pages per run (a collapse usually means markup/pagination changed upstream)
3. **Saved searches** — per-search freshness (`age_min`, colour-coded), listing counts, new/drop counters
4. **Recent scrape runs** — newest 50 with status colouring and full error text
5. **Data quality & upstream** — coverage of geo pins / detail fetches / KM-m² / OLX status among actives (how much data the market panels can actually rely on), an OLX-status-vs-our-closure drift table (`api_status` telemetry), and per-search run durations
6. **Errors & latency** — error messages grouped with digits masked to `#` (tells one recurring bug from many transient failures) and a run-duration trend (avg/max per hour); duration creep is the leading indicator of OLX throttling

## Metrics not charted (yet)

- **Dead columns** (never populated by the scraper): `heating`, `furnished`, `favorites` — don't build panels on these. (`location` used to be dead but is now filled for Banja Luka pins by the neighborhoods backfill.)
- **Sparse but charted with caveats**: `floor_num` (~12 % of actives) powers the floor-position gauge, with explicit `n=` counts per bucket so sparsity stays visible. Still too sparse to chart: `parking` (6 %), `elevator` (4 %), `bathrooms` (11 %), `year_built` (20 %). Revisit as detail enrichment converges.
- **Needs scraper/schema work**: `views` and `favorites` are overwrite-in-place counters, so no history/trend is possible without snapshotting them (e.g. a `listing_stats_history` table). `api_price_history` (OLX's own server-side price log, ~7 % coverage) could power hidden-drop detection we can't see between cycles.



