# Benchmark results — 2026-09-24 to 2026-09-26

## Results

The live PostgreSQL baseline contained 1,262 active listings, 129,068 daily facts, and 45,219 price events. The initial OLAP source profiles were cache-warm. After the applied query changes, the comparable live profiles showed the largest gains in price-change, daily-fact, comparison-input, and resolved-price-evidence reads:

| Workload | Baseline | Optimized result | Change |
| --- | ---: | ---: | ---: |
| `comparison_price_changes_source` | 11,025 ms | 908 ms | −91.8% |
| `daily_listing_facts_source` (all rows, JIT off) | 7,890 ms | 3,941 ms | −50.0% |
| `current_comparison_inputs` (JIT off) | 1,036 ms | 566 ms | −45.3% |
| `resolved_price_evidence` (JIT off) | 511 ms | 300 ms | −41.3% |
| `current_listing_scores_source` (JIT off) | 4,282 ms | 3,921 ms | −8.4% |
| `daily_listing_facts_source` (category normalization pass, JIT off) | 3,560 ms | 3,288 ms | −7.6% |

These are individual cache-warm comparisons, except where the repeated refresh and rebuild-window trials are identified below. Lifecycle cycle lookup used 21.7% fewer shared buffer hits; its elapsed-time samples did not establish a speedup. The daily-facts one-day profile showed no gain from category normalization reuse.

The final full live OLAP profile reported 9 fresh, consistent marts and 273,887 tracked rows. Refreshes completed in 1,418 ms for the dirty pass and 52–50 ms for near-idle passes. The score source remained the heaviest query and wrote temporary blocks. On 2026-09-26, the live refresh published generation 231; exact checks found no missing or unexpected rows in daily facts (130,639), lifecycle cycles (2,034), or lifecycle movements (2,762).

The original live database occupied 264,828,607 bytes. Compaction reduced it to 257,406,655 bytes before the duplicate daily-market projection was removed. The duplicate projection occupied 27,131,904 bytes and was removed after its 129,068 rows matched the daily-facts projection exactly. A later custom-format dump measured 14,443,977 bytes before that removal. Physical compaction reclaimed dead space without removing live records; logical dump sizes remained essentially unchanged.

### Other benchmark workloads

| Workload | Results |
| --- | --- |
| Ingestion | 100 / 500 / 1,200 cards in 145 / 380 / 838 ms; 15 statements per cohort, no dropped rows. |
| Regression | 10,000-listing latest-price lookup across 1.2 million events: 1,101 ms; filtered 20-day market query: 226 ms. The event index was used; no safe index removal was identified. |
| Analytics baseline | One-day rebuild: 8,364 ms; incremental refresh: 19,384 ms; 200-point geography batch: 10 ms. |
| Score refresh with neighborhood-distance cache | Three-run median refresh fell from 25,272 ms to 19,031 ms (−24.7%) on matched disposable clones. Cache size: 464 kB. |
| Rebuild-window lookup | Three-run median fell from 101.604 ms to 45.710 ms (−55.0%) on a disposable restore. This measures interval selection only. |

## Applied optimizations

- **Comparison price changes:** Removed the source's dependency on the expensive current-comparison-input view for article, deal-segment, and cycle-start values. The matched inputs and price-change rows were equivalent; the source ran 91.8% faster in the recorded comparison.
- **Daily facts:** Materialized the deal-boundary history calculation once and reused it for price and rate quality. The full source returned the same 129,068 rows and ran 50.0% faster in the JIT-off comparison. Category memberships are now normalized once and reused; the full-source sample improved 7.6%, while the one-day sample did not improve.
- **Price evidence:** Resolve deal state only after selecting the latest event, and consult history only when the event lacks an explicit deal type. The current-comparison-input and resolved-evidence profiles used fewer buffer hits and ran faster in their matched samples. The downstream score profile improved from 4,282 ms to 3,921 ms in the JIT-off comparison.
- **Lifecycle history:** Materialize each eligible boundary-history slice once and reuse it for scalar, category, and JSON aggregations. Shared buffer hits fell 21.7%; elapsed-time improvement was not established.
- **Incremental daily refresh:** Stage daily facts and market rows, retaining identical stored rows and replacing only changed or obsolete rows. On an unchanged day, rewrites fell from 3,156 to zero and elapsed time fell 18.5% in one matched trial.
- **Historical daily rebuild:** Stage the replacement cohort and write only changed or missing rows. An unchanged 1,578-row day required zero persistent rewrites and was 7.7% faster in one matched trial; changed and obsolete rows remain correctly handled.
- **Score refresh:** Cache exact nearest-neighborhood distance rankings and refresh the cache when neighborhood boundaries change. Cached results matched all 2,962 reference pairs; matched refresh median improved 24.7%.
- **Rebuild-window selection:** Calculate the analytics rebuild interval once in the database and batch that returned interval in the scraper. The lookup median improved 55.0% in the recorded trial.
- **Duplicate daily-market storage:** Removed `olap.public_daily_market` and its refresh writes after confirming exact row parity with `olap.daily_listing_facts`. The removed relation occupied 27,131,904 bytes.
- **Dead-space reclamation:** `VACUUM (FULL, ANALYZE)` reclaimed dead physical space from `raw_api_responses` (−17.3%), the September daily-fact/listing-daily/market partitions (database −1.1% in that pass), `olap.lifecycle_cycles` (−38.4%), and `listing_detail_versions` (−21.4%). These are one-time savings; later updates and refreshes can create dead space again.
- **Current-schema cleanup:** Removed completed backfills, duplicate-body conversion, transition-marker tables, unused geometry helpers, and redundant daily-fact views. Migration startup now loads its ledger in one query. Batched raw-detail diagnostics omit response bodies while successful archives retain the original response. Grafana now provisions one dashboard directory and updates its datasource in place. Stored historical price provenance and live row counts were preserved.

## Validation

The applied migrations and live refreshes left all nine marts fresh and generation-consistent. Recorded exact parity checks found no missing or unexpected rows in the checked marts; focused migration and integration suites passed. The final current-schema cleanup passed 156 unit tests, the database integration suite, ESLint, and Markdown-link checks. Grafana's recreated datasource reported `Database Connection OK`.
