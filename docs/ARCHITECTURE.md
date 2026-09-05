# Architecture and data model

The stack collects configured OLX search results, stores current state and durable evidence in PostgreSQL, and serves provisioned Grafana dashboards. It is designed for market observation: an asking price or a listing disappearance is not a verified transaction.

## Runtime

`scraper/src/index.js` is the production entrypoint. On startup it waits for PostgreSQL, applies the unapplied files in `db/init/`, converts eligible legacy price history, starts the health endpoint, and runs every configured search. Without `--once`, it repeats at `SCRAPE_INTERVAL_MINUTES` and never overlaps cycles. `src/migrate-only.js` applies migrations without scraping; `src/backfill-price-history.js` performs the offline price-history conversion.

Searches come from `/config/searches.json`, unless `SEARCH_URLS` is set. Each URL is normalized to a stable search key. The scraper converts it to the OLX JSON search endpoint, fetches page 1 first, then fetches later pages in paced concurrent waves. A blank first page, failed page, or incomplete pagination marks the run unsuccessful; its prior result membership is retained. A cycle with no cards skips the closing pass. These guards prevent a blocked or changed upstream response from mass-closing listings.

For a complete search, one ingestion transaction updates the current listing, search membership, run statistics, search observations, canonical price events, and reopen/close transitions caused by that search. A cycle-level closing pass then closes listings no longer returned by any configured search. Successful cycles rebuild pending daily inventory and remove expired raw search responses.

Detail enrichment is a separate, bounded part of a successful search. The queue prioritizes active rows that have never had a successful detail fetch, are stale, have changed price, or still lack a pin or sale area. Search cards provide the inexpensive facts; detail requests fill richer attributes. Failed detail requests are recorded as attempts but are not treated as successful detail evidence.

## Persistence and evidence

| Store | Purpose |
|---|---|
| `listings` | Current, one-row-per-article state and the latest known attributes. It retains closed listings. |
| `search_results` and `saved_searches` | Current membership of each configured search and its identity/category. |
| `scrape_runs` | Per-search execution outcome, page/card counts, completeness, and failure information. |
| `raw_api_responses` | Retained search payloads with fetch time, parser version, and expiry. Retention is controlled by `RAW_RESPONSE_RETENTION_DAYS`; this is operational evidence, not an indefinite archive. |
| `listing_state_history` | Immutable search sightings, detail updates, closures, and reopenings. `effective_at` is evidence time; `ingested_at` is when this database learned it. |
| `listing_price_events` | Canonical price boundaries with a value state (`valid`, `unpriced`, `invalid`, or `conflict`) and provenance. |
| `listing_daily` | Reconstructed article/day inventory used for historical analytics. |
| `analytics_refresh_state` | Pending and successful daily-rebuild coverage. |
| `neighborhoods` | Generated Banja Luka MZ polygons used to resolve listing pins. |

`price_history` remains the legacy append-only snapshot table and is still consumed by the conversion path. New canonical price evidence is written through `listing_price_events`; duplicate evidence is idempotent by article, effective time, normalized price, and state.

Current tables answer “what is known now.” Evidence tables answer “what did this source say, and when did we record it?” `listing_daily` answers historical questions by reconstructing state at each Sarajevo calendar-day boundary. It carries explicit `membership_inferred`, `attributes_inferred`, `stale_observation`, and `provisional_day` flags. Historical membership and attributes can be inferred when observations are sparse; today is provisional and active inventory can be carried through the configured 14-day observation window. Treat flagged values as estimates, not direct daily captures.

## Listing lifecycle and details

A listing opens when it is first observed. Complete search membership updates `last_seen`; when it disappears from all currently configured searches, the closing pass sets `closed_at` and freezes the last asking price, price per square metre, and category. A later sighting reopens the listing. Listings absent because a search failed are deliberately not closed.

The closing price is the last observed asking price, not a sale price. `published_at` and `renewed_at` come from source data when available; they differ from local observation time. Detail values include seller type, characteristics, counters, source status, and source price history. Stable scalar detail facts are generally first-wins, characteristics are merged, and a successful detail request updates `details_fetched_at`. Coverage varies by listing and by what OLX exposes.

Price quality is explicit. A valid price without valid area can remain price evidence but has no price-per-square-metre value. Dashboard measures therefore exclude unsuitable rows where their query requires a valid price, area, or detail attribute.

## Database ownership and migrations

PostgreSQL initialization runs `db/init/*.sql` only for a new volume. The scraper also records and applies unapplied migrations by filename at startup. Add future schema changes as new idempotent files; do not edit generated neighborhood SQL by hand. The bootstrap database user administers the instance. `olx_app` owns application objects and is used by the scraper and restore endpoint; `olx_reader` is read-only and is used by Grafana and backups.

## Dashboards

Grafana provisions a read-only PostgreSQL datasource and four dashboard definitions from `grafana/dashboards/`:

- **OLX.ba Home** summarizes current market and scraper health without market filters.
- **OLX.ba Market Overview** shows active inventory, asking-price trends, search-derived market flow, maps, segments, and selected detail coverage. Its Category, Deal, Rooms, m², and Neighborhood variables scope applicable panels.
- **OLX.ba Exits & Price Endings** examines closed listings. Exit values are final observed asking values; they are not sales. It uses the same market filters.
- **OLX Scraper Health** shows run outcomes, freshness, throughput, errors, and data-quality coverage. Its Category variable scopes search-related panels, not the market dataset.

Dashboard formulas are query-specific: comparable-looking ratios can use different scopes and denominators. Read panel titles and query aliases as the authoritative definition. Daily inventory and flow are estimates built from stored evidence, and raw/detailed-data coverage limits map, segmentation, and attribute panels.

## Geography

`geo/banja-luka-mz-final.geojson` is the final source for the generated `db/init/11-neighborhoods.sql`. `neighborhood_of(lat, lon)` uses polygon containment, deterministic priority on shared borders, then a nearest-polygon fallback within 5 km. A missing pin is reported as `(no pin)`; a pin outside the supported coverage is `(unmapped)`. See [geo/README.md](../geo/README.md) and [DATA.md](../DATA.md) for the reproducible chain and attribution.
