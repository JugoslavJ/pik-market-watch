# Database, Grafana, and scraper map

Use this as a repository-derived architecture brief for performance review. The SQL definitions in `db/init/` and the provisioned dashboard JSON in `grafana/dashboards/` are authoritative. This map does not contain live row counts, query plans, or production timings.

## 1. Database shape

PostgreSQL with PostGIS, split into three application schemas:

- `public` is the scraper-owned OLTP system of record: current listing state, search membership, scraper runs, raw API evidence, and historical evidence.
- `olap` contains physical, dashboard-grain snapshots. Scraper ingestion does not write these marts directly.
- `reporting` is the stable read API for Grafana: views and parameterized functions over OLAP snapshots, plus a small amount of live operational state.

The normal query path is:

```text
Grafana SQL -> reporting views/functions -> olap snapshot
                                       \-> selected live health/control views
Scraper -> public OLTP/evidence -> reporting source views -> refresh functions -> olap
```

The app, reporting, migrator, and backup roles are separate. Grafana uses the read-only `olx_reporting` role. The canonical schema baseline is the ordered SQL set under `db/init/`; it is not a dump of current production statistics.

### Physical tables by purpose

**Current state and search membership (`public`)**

- `listings`: one current row per OLX article; current asking-price fields, details, coordinates, and closure snapshot. Closed rows are retained.
- `saved_searches`: configured search identity and latest summary stats.
- `search_results`: current many-to-many membership between configured searches and articles. A disappeared listing remains active if another search still contains it.
- `detail_jobs`: durable detail-fetch queue state, retries, and leases.

**Evidence and version history (`public`)**

- `listing_state_history`: append-only search sightings, detail changes, closures, and reopenings; partitioned by time.
- `listing_price_events`: canonical append-only price evidence, including `valid`, `unpriced`, `invalid`, and `conflict` states; partitioned by time.
- `listing_publication_evidence`: source evidence for publication dates.
- `listing_detail_versions`: versioned snapshots of listing detail attributes.
- `listing_state_version_records` plus `listing_state_characteristic_documents`: deduplicated listing-state attributes. `listing_state_versions` is the logical compatibility view that reconstructs characteristics JSON.
- `price_history`: older price-history relation retained in the schema; `listing_price_events` is the canonical price-evidence path used by current analytics.

**Historical inventory and rebuild controls (`public`)**

- `listing_daily`: reconstructed article-by-local-day state used for historical inventory; partitioned by day. It includes quality/inference flags and references to state/detail versions.
- `analytics_refresh_state`, `analytics_daily_coverage`, `analytics_daily_dirty_articles`, `analytics_daily_olap_dirty`: pending rebuild ranges, per-day coverage, article invalidation, and daily OLAP invalidation.
- `analytics_contract_validation`: validation results for analytics/reporting contracts.

**Scrape and API diagnostics (`public`)**

- `scrape_runs`: one execution record per configured search attempt.
- `scrape_run_pages`: per-page attempt manifest, response state, parse counts, and errors.
- `raw_api_response_pending` and `raw_api_response_records`: inline intake and compacted retained API payloads. `raw_api_responses` is a logical view over both.
- `storage_json_documents` and `storage_json_parts`: content-addressed shared JSON fragments used to compact retained raw responses.
- `maintenance_runs`: task outcomes, elapsed/affected-row details, and errors.

**Geography and database operations (`public`)**

- `neighborhoods`: Banja Luka neighborhood polygons and derived geometry.
- `neighborhood_neighbor_cache`: ranked nearby-neighborhood distances used for local comparable selection.
- `olap_article_dirty`: article-level invalidation for current OLAP marts.
- `analytics_partition_policy`, `analytics_partition_registry`, `analytics_retention_policy`: partition creation/validation and operational retention configuration.

**Physical dashboard marts (`olap`)**

- Current listing copies/snapshots: `listings`, `current_listing_scores`, `listing_categories`, `dashboard_filter_options`.
- Daily facts and market flow: `daily_listing_facts`, `market_daily`.
- Lifecycle and exit facts: `lifecycle_cycles`, `lifecycle_movements`, `listing_exit_economics`.
- Price history facts: `listing_price_changes`, `comparison_price_changes`.
- Public dashboard contracts: `public_current_listings`, `public_exit_cycles`, `public_freshness`, `public_price_reductions`.
- Refresh bookkeeping: `refresh_state` (row count, source watermark, timestamp, generation ID per mart).

`reporting.current_market_refresh_state` records current-market refresh metadata. Other commonly used reporting contracts include `dashboard_listings`, `current_listing_scores`, `daily_listing_facts_olap`, `market_daily`, `price_changes`, `comparison_price_changes`, `lifecycle_cycles`, `lifecycle_movements`, `exit_economics`, `freshness`, `scrape_health`, `saved_searches`, `listing_health`, `analytics_refresh_state`, `olap_health`, and `olap_queue_health`.

### History semantics that affect query results

- A closing price is the final observed asking price, never a confirmed sale price.
- `listing_daily` is reconstructed at the `Europe/Sarajevo` calendar-day boundary. Sparse history can produce inferred membership/attributes; recent active rows can be carried forward. Inspect `membership_inferred`, `attributes_inferred`, `stale_observation`, and `provisional_day` before treating history as a direct daily capture.
- Price state and currency are explicit. A retained numeric `listings.price` does not necessarily mean the latest price evidence is currently valid/priced.
- Neighborhood assignment is derived from a listing pin and the supported polygon set; missing pins and out-of-coverage pins are distinct.

## 2. What Grafana queries

There are seven provisioned dashboards. Exact SQL, panel transformations, variables, and time macros are in each matching `grafana/dashboards/*.json`. Many panels are separate queries even when they share a filtered reporting function. Some stat panels use Grafana expressions rather than a standalone SQL target.

| Dashboard | Main query families and contracts |
| --- | --- |
| **OLX.ba Home** (`olx-home.json`) | Unfiltered active inventory via `reporting.dashboard_listings`; market flow and active estimates via `reporting.market_daily`; sale-rate and rent/sale trend summaries from `reporting.daily_listing_facts_olap`; run freshness/errors via `reporting.scrape_health`. |
| **OLX.ba Market Overview** (`olx-overview.json`) | Current listings through `reporting.overview_listings_filtered`; sale segmentation through `reporting.overview_sale_segments`; historical trend through `reporting.daily_listing_facts_olap` and `reporting.market_daily_filtered`; price reductions through `reporting.price_changes` / `reporting.price_changes_filtered`; listings, maps, room/floor/seller/neighborhood breakdowns use the shared current-market scope. Category, deal, room, area, and neighborhood variables apply where supported. |
| **OLX.ba Exits & Price Endings** (`olx-exits.json`) | Closed population via `reporting.exits_closed_filtered`; original/opening value and observed duration via `reporting.exit_economics`; room/deal/category/area/neighborhood breakdowns, final observed asking value, exit maps, and daily asking-vs-exit comparisons (the latter also reads `reporting.daily_listing_facts_olap`). Ratios describe observed closures, not verified transactions. |
| **OLX Scraper Health** (`olx-health.json`) | Operational state from `reporting.scrape_health`, `reporting.saved_searches`, and `reporting.listing_health`; price quality from `reporting.price_event_health`; daily rebuild and OLAP status from `reporting.analytics_refresh_state`, `reporting.olap_health`, and `reporting.olap_queue_health`. Category scopes search-related panels, not the full market dataset. |
| **Buyer** (`olx-buyer.json`) | Repeated calls to `reporting.buyer_listing_scope` for counts, maps, comparisons, and paginated listings; current score/comparable facts via `reporting.current_listing_scores` and `reporting.listing_comparables`; context trends from `reporting.daily_listing_facts`; selected article history from `reporting.comparison_price_changes`; freshness and bound validation via `reporting.freshness` and `reporting.within_bounds`. |
| **Renter** (`olx-renter.json`) | Same pattern using `reporting.renter_listing_scope`; current scores/comparables; daily rent context; current-cycle price history; freshness and filter validation. |
| **Agent** (`olx-agent.json`) | Same pattern using `reporting.agent_listing_scope`; current scores/comparables; daily asking-rate trends, lifecycle supply movement/exits, price changes, freshness, and filter validation. |

The persona dashboards each run several independent panels over the same broad listing scope (KPI counts, maps, price distributions, paginated results, selected-listing detail, and related history). Overview also repeats its selected filter set across multiple panels. This is a useful area to inspect with actual Grafana query timings and `pg_stat_statements`; shared SQL text does not mean Grafana shares one result between panels.

## 3. How scraper writes data

1. **Cycle setup.** `scraper/src/index.js` applies/validates migrations, recovers stale running records, and takes a session advisory lease so cycles do not overlap. It processes configured searches in sequence and shares one OLX API rate budget across search and detail calls.
2. **Run registration.** `scraper/src/scraper.js` validates the OLX API filter, inserts a `scrape_runs` row, and upserts `saved_searches` before fetching pages.
3. **Page harvest and diagnostics.** `scraper/src/search/harvest.js` fetches page 1, verifies metadata, then fetches later pages in paced concurrent waves. It deduplicates article IDs, records one `scrape_run_pages` manifest per attempt, and archives search payloads/diagnostics to `raw_api_responses` (backed by pending intake). Malformed, blocked, failed, or truncated pagination makes the run incomplete; incomplete results do not replace membership or mass-close listings.
4. **Atomic complete-search ingestion.** `scraper/src/db/ingestion.js` uses one transaction and a lifecycle advisory transaction lock. It bulk inserts new `listings` via `jsonb_to_recordset`, then bulk-updates current search-card fields for known IDs. It appends search sightings to `listing_state_history` and canonical normalized price observations to `listing_price_events`. It replaces that search's `search_results` membership set, logs reopen/closure transitions and their history, marks `listing_daily` dates dirty, updates `saved_searches` summary stats, finalizes the `scrape_runs` row, and commits all of those together. Database triggers calculate rates, attach compact version references, enforce append-only evidence, and mark affected marts dirty.
5. **Detail enrichment after commit.** `scraper/src/search/enrichment.js` asks the DB for a bounded/fair-share queue (default cap: 25 detail calls per run), claims leases in `detail_jobs`, and fetches richer fields only for new, stale, changed-price, or incomplete active listings. `scraper/src/db/enrichment.js` bulk-updates listings, records publication/detail/state and price evidence, and completes job outcomes. This phase is best effort and cannot roll back a committed search ingestion.
6. **Cycle-level closure.** After all searches, `scraper/src/db/lifecycle.js` removes membership links for deconfigured searches and closes rows with no remaining configured-search membership. Failed searches retain their prior links. A zero-card cycle skips closure unless all configured searches were authoritatively complete.
7. **Rebuild, cleanup, and publication.** Maintenance purges expired raw responses, compacts retained raw JSON into shared documents, creates/analyzes partitions, and rebuilds pending `listing_daily` days in bounded windows. The scraper's enabled current-market publication calls `reporting.refresh_current_market()`, which refreshes OLAP marts from canonical source views, ensures partitions, runs operational cleanup and contract validation, and analyzes published targets. Grafana reads the published snapshot instead of rebuilding current scores/event history in each panel.

Important code paths: `scraper/src/index.js`, `scraper/src/scraper.js`, `scraper/src/search/harvest.js`, `scraper/src/search/enrichment.js`, `scraper/src/db/ingestion.js`, `scraper/src/db/lifecycle.js`, `scraper/src/db/enrichment.js`, `scraper/src/price-history.js`, and `scraper/src/db/maintenance.js`.

## 4. Performance-review request for Claude

Please review this architecture and the attached repository SQL/dashboard definitions for likely database inefficiencies. Separate evidence-backed findings from hypotheses. Rank findings by likely impact and explain the exact query/table path, the mechanism causing extra work, a measurement to confirm it (for example `pg_stat_statements`, `EXPLAIN (ANALYZE, BUFFERS)`, refresh duration, row counts, or lock/WAL metrics), and a safe optimization direction. Pay particular attention to repeated panel scans over the same scope functions, CTE materialization/filter pushdown, large source-view calculations during OLAP refresh, temporal evidence lookups, partition pruning, indexes versus write/trigger cost, and JSON reconstruction. Preserve the evidence, inferred-history, price-state, lifecycle, and failed-search semantics; do not recommend an index or rewrite without identifying its workload and correctness tradeoff. The repo does not include live table sizes or production query plans, so label anything requiring runtime evidence.
