# Grafana Performance Optimization Plan

This plan optimizes dashboard latency and total database work while keeping the existing Oracle VM.Standard.A1.Flex deployment:

- 2 OCPU
- 12 GB RAM
- no infrastructure upgrade

Execute the work in stages and measure each stage before starting the next.

## Guiding principles

- Optimize complete-dashboard load time and total database work, not only individual query duration.
- Preserve dashboard semantics unless a behavior change is explicitly documented and tested.
- Do not introduce Redis, external caches, TimescaleDB, another database, or additional infrastructure unless these optimizations fail.
- Do not stack several unmeasured changes and then guess which one helped.
- Preserve reporting.listings_filtered() for compatibility while introducing an overview-specific function.
- Prefer existing OLAP structures over new physical tables unless measurements justify a new mart.
- Do not add indexes without execution-plan or benchmark evidence.

## Target outcomes

| Metric | Target |
| --- | ---: |
| Simple current-market SQL | < 20–30 ms warm |
| Grouped/percentile SQL | < 50–75 ms warm |
| Dashboard-variable SQL | < 10–20 ms |
| Typical historical trend SQL | < 75–100 ms warm |
| Database queries per overview load | Substantially below current count |
| PostgreSQL CPU available | Approximately 1.25 OCPU baseline |
| Dashboard output | No semantic changes |

## Current bottleneck hypothesis

PostgreSQL is currently restricted to approximately 0.5 CPU and 768 MB, while Grafana has approximately 1 CPU and 768 MB and can open up to 20 PostgreSQL connections. That allocation is poorly matched to an analytics workload because PostgreSQL performs the expensive filtering, grouping, percentile, and historical work.

The overview dashboard also invokes reporting.listings_filtered() roughly 22 times, often with the same category/area/neighborhood population, and repeatedly calculates room_bucket and deal filtering outside the function.

## Stage overview

| Stage | Scope | Source phases |
| --- | --- | --- |
| 1 | Instrumentation and baseline | 1 |
| 2 | Resource allocation and concurrency controls | 2–4 |
| 3 | Dashboard variables and canonical current-market filtering | 5–7 |
| 4 | Consolidate current-market dashboard queries | 8–12 |
| 5 | Rewrite historical filtering around physical OLAP facts | 13–14 |
| 6 | Plan-driven indexes and statistics | 15–16 |
| 7 | Correctness and semantic regression testing | 18 |
| 8 | Final rebenchmark and evidence-based decisions | 17 and 19 |

The recommended execution order is strict. Do not begin a later stage until the preceding stage has produced its measurements or documented why measurement was impossible.

---

## Stage 1 — Establish a performance baseline

### Objective

Measure current dashboard and database behavior before changing SQL or resource limits.

### Required work

1. Enable PostgreSQL instrumentation in docker-compose.yml:

~~~yaml
- -c
- shared_preload_libraries=pg_stat_statements
- -c
- track_io_timing=on
~~~

2. Install the extension through the project's migration mechanism, not only through /docker-entrypoint-initdb.d:

~~~sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
~~~

The existing database volume will not rerun first-boot scripts.

3. Capture the top statements:

~~~sql
SELECT
    query,
    calls,
    total_exec_time,
    mean_exec_time,
    min_exec_time,
    max_exec_time,
    rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 30;
~~~

4. Capture EXPLAIN (ANALYZE, BUFFERS, SETTINGS) for important queries.
5. Benchmark:

   - Overview dashboard with default filters
   - Sale only
   - Rent only
   - One category
   - One neighborhood
   - One room bucket
   - Category + neighborhood + rooms
   - 30-day historical range
   - 90-day historical range

6. Capture docker stats during a complete dashboard refresh.
7. Record in docs/performance-baseline.md:

   - Total dashboard load time
   - Number of SQL requests
   - Mean SQL time
   - Approximate p95 SQL time
   - Database CPU and memory
   - Rows scanned by expensive queries

### Acceptance criteria

- Instrumentation is active on the existing database volume.
- Measurements exist for all listed workloads, or missing measurements are documented.
- Top expensive statements and representative plans are recorded.

### Agent prompt

~~~text
Work only on Stage 1 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md: establish a performance baseline.

Inspect the repository's Docker, migration, Grafana, database, and documentation conventions before editing. Enable pg_stat_statements and track_io_timing in the existing PostgreSQL command. Install pg_stat_statements through the project's migration mechanism so it works with an existing database volume; do not rely only on first-boot init scripts.

Measure the current overview dashboard for the required filter combinations and 30-day/90-day historical ranges. Capture pg_stat_statements, representative EXPLAIN (ANALYZE, BUFFERS, SETTINGS) plans, and docker stats during complete dashboard refreshes. Record dashboard load time, SQL request count, mean and approximate p95 SQL time, database CPU/memory, and expensive-query row counts in docs/performance-baseline.md.

Do not optimize SQL or change resource limits in this stage. Keep existing behavior unchanged. Run the narrowest relevant verification and report exactly what was measured, what could not be measured, and any environment limitation.
~~~

---

## Stage 2 — Correct resource allocation and concurrency

### Objective

Give PostgreSQL enough CPU and memory while preventing Grafana and maintenance jobs from creating avoidable contention on the 2-OCPU VM.

### PostgreSQL target

Initial target:

~~~yaml
db:
  mem_limit: 2g
  memswap_limit: 2g
  cpus: 1.25
~~~

PostgreSQL settings:

~~~text
shared_buffers=512MB
effective_cache_size=1536MB
work_mem=8MB
maintenance_work_mem=128MB
max_connections=40
~~~

Keep:

~~~text
random_page_cost=1.1
effective_io_concurrency=200
checkpoint_completion_target=0.9
wal_compression=on
~~~

Do not substantially increase work_mem; it applies per sort/hash operation and the dashboard contains multiple percentile/grouping queries.

### CPU and Grafana A/B tests

Benchmark PostgreSQL at 1.00, 1.25, and 1.50 CPU. Use 1.25 as the initial production value. Use 1.50 only if it meaningfully improves complete-dashboard time without starving Grafana, Cloudflare Tunnel, scraping, or maintenance. Do not assign both host CPUs exclusively to PostgreSQL.

Change Grafana to:

~~~yaml
maxOpenConns: 8
maxIdleConns: 4
~~~

Benchmark six versus eight connections after the SQL work. Keep the setting with the best complete-dashboard render time, not the best isolated query throughput.

### Maintenance and scraper limits

Make resource control consistent for scraper, maintenance, olap-reconcile, and migrator where appropriate:

~~~yaml
cpus: 0.50
mem_limit: 512m
memswap_limit: 512m
~~~

Do not run multiple analytics maintenance/reconciliation jobs concurrently.

### Acceptance criteria

- Selected PostgreSQL CPU/memory values are supported by measurements.
- Grafana connection limits are supported by complete-dashboard measurements.
- Maintenance and reconciliation jobs cannot consume both host CPUs or exceed their intended memory budget.
- No dashboard semantics change.

### Agent prompt

~~~text
Work only on Stage 2 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md: resource allocation and concurrency controls.

Inspect docker-compose.yml, PostgreSQL configuration, Grafana datasource configuration, and shared runtime definitions. Apply the initial PostgreSQL target of 2 GB RAM, 1.25 CPU, shared_buffers=512MB, effective_cache_size=1536MB, work_mem=8MB, maintenance_work_mem=128MB, and max_connections=40, while preserving the listed existing settings. Apply Grafana maxOpenConns=8 and maxIdleConns=4 unless repository conventions require an equivalent representation.

Make scraper, maintenance, olap-reconcile, and appropriate migrator limits consistent at 0.50 CPU, 512 MB memory, and 512 MB memswap. Ensure analytics maintenance/reconciliation jobs are not intended to run concurrently.

Perform CPU A/B measurements at 1.00, 1.25, and 1.50 where possible, and compare Grafana connection settings of 6 and 8 after the SQL work or document why that comparison must be deferred. Optimize for complete-dashboard render time and host contention, not isolated query throughput.

Do not refactor dashboard SQL in this stage. Preserve semantics, run configuration validation, and report the chosen values and measurements.
~~~

---

## Stage 3 — Replace fact-table variables and create the canonical current filter

### Objective

Stop dashboard variables from scanning historical facts and move all current-market dashboard filters into one reusable function.

### Dashboard filter options

Create:

~~~sql
CREATE TABLE olap.dashboard_filter_options (
    filter_name text NOT NULL,
    value text NOT NULL,
    sort_order integer,
    PRIMARY KEY (filter_name, value)
);
~~~

Expose it through:

~~~sql
CREATE VIEW reporting.dashboard_filter_options AS
SELECT filter_name, value, sort_order
FROM olap.dashboard_filter_options;
~~~

Populate it as part of the existing OLAP publication process. Store values for category, room_bucket, and neighborhood. For neighborhoods, retain (no pin) and (unmapped) if they are part of current dashboard semantics.

Variables should use indexed lookups such as:

~~~sql
SELECT value AS __value,
       value AS __text
FROM reporting.dashboard_filter_options
WHERE filter_name = 'category'
ORDER BY sort_order NULLS LAST, value;
~~~

Use the same pattern for room buckets and neighborhoods. Keep Deal as a static custom Grafana variable. No variable query may reference reporting.daily_listing_facts.

### Canonical current-market function

Create a new function without breaking the old contract:

~~~sql
reporting.overview_listings_filtered(
    p_category text[],
    p_min_sqm numeric,
    p_max_sqm numeric,
    p_neighborhood text[],
    p_rooms text[],
    p_deal text[],
    p_active_only boolean DEFAULT true
)
~~~

It must apply active status, minimum/maximum area, neighborhood, room bucket, deal, and category membership internally. Preserve the existing active-only semantics:

~~~sql
l.closed_at IS NULL
AND l.last_seen > now() - INTERVAL '14 days'
~~~

Use olap.listing_categories for category membership where appropriate. Retain reporting.listings_filtered() for other dashboards during migration.

### Normalized dimensions

Inspect olap.current_listing_scores, which already stores normalized deal, neighborhood, and room_bucket and has an index on (deal, property_type, neighborhood, room_bucket).

Apply the same pattern to the overview path. Prefer extending olap.listings with normalized fields. Create olap.dashboard_listings only if extending the existing mart is not conceptually clean and measurements justify it. Candidate fields are deal, room_bucket, dashboard_neighborhood, and category_memberships.

Do not force the overview to use current_listing_scores unless it contains every field the overview requires, including views, publication/renewal data, coordinates, and floor information.

### Acceptance criteria

- Category, Rooms, and Neighborhood variables use the small options structure.
- Variable queries do not reference historical fact tables.
- overview_listings_filtered() applies all dashboard filters.
- Existing reporting.listings_filtered() remains compatible.
- Normalized dimensions are reused where practical and the choice is supported by evidence.

### Agent prompt

~~~text
Work only on Stage 3 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md.

Inspect the existing OLAP publication/migration mechanism, current Grafana variables, reporting functions/views, olap.listings, olap.listing_categories, and olap.current_listing_scores. Implement olap.dashboard_filter_options with a reporting.dashboard_filter_options view, populated by the existing OLAP publication process. Preserve dashboard semantics, including (no pin) and (unmapped) neighborhood values when currently present.

Update Category, Rooms, and Neighborhood Grafana variables to use indexed lookups against the options structure. Ensure no variable query references reporting.daily_listing_facts. Keep Deal as the existing static custom variable.

Add reporting.overview_listings_filtered(p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[], p_rooms text[], p_deal text[], p_active_only boolean DEFAULT true). It must apply active status, area, neighborhood, room, deal, and category filters internally. Retain reporting.listings_filtered() for compatibility. Reuse or add normalized current-listing dimensions only where the repository design supports it; do not create a redundant physical mart without justification.

Do not consolidate KPI or other dashboard queries yet. Add focused database tests or SQL checks for empty filters and each individual filter. Run migrations/config validation and report changed files, semantic decisions, and query-plan evidence.
~~~

---

## Stage 4 — Consolidate current-market dashboard queries

### Objective

Build each filtered current population once and reduce PostgreSQL requests and repeated scans in grafana/olx-overview.json.

Start with the overview dashboard only; do not migrate every dashboard at once.

### Headline KPIs

The following currently use essentially the same population:

- Active listings
- New in the last 7 days
- Median sales KM/m²
- Median monthly rent

Replace them with one SQL request using a materialized base:

~~~sql
WITH base AS MATERIALIZED (
    SELECT *
    FROM reporting.overview_listings_filtered(...)
)
SELECT
    count(*) AS active,
    count(*) FILTER (
        WHERE first_seen > now() - INTERVAL '7 days'
    ) AS new_7d,
    percentile_cont(0.5)
        WITHIN GROUP (ORDER BY ppm2)
        FILTER (WHERE NOT is_rent AND ppm2 > 0) AS median_sale_ppm2,
    percentile_cont(0.5)
        WITHIN GROUP (ORDER BY price)
        FILTER (WHERE is_rent AND price > 0) AS median_rent
FROM base;
~~~

Display the values from one result, or use Grafana's Dashboard data source so stat panels reuse that result.

### Price-cut statistics

Consolidate active listings with previous reductions and median biggest reduction into one query. Build the cuts population once, build the filtered current base once, then join by article_id. Preserve existing date and active semantics.

### Sales segmentation

Create a reporting query or function such as reporting.overview_sale_segments(...) with output:

~~~text
dimension
bucket
listing_count
median_ppm2
p25_ppm2
p75_ppm2
~~~

Build the filtered sales base once and reuse it for room bucket, condition, floor position, seller type, and neighborhood as applicable. Use one Grafana datasource request and let panels select dimension from the returned frame. Do not combine unrelated historical or price-change work into this query.

### Scatter and regression

Replace the raw scatter query and separate regression scan with one query. Build the sale base once, calculate regression coefficients from it, and return both listing and fit series with a series discriminator:

~~~sql
WITH base AS MATERIALIZED (
    SELECT sqm::float8 AS sqm, price::float8 AS price
    FROM reporting.overview_listings_filtered(...)
    WHERE NOT is_rent
      AND price IS NOT NULL
      AND ppm2 > 0
      AND sqm > 0
), fit AS (
    SELECT
        min(sqm) AS x0,
        max(sqm) AS x1,
        regr_slope(price, sqm) AS slope,
        regr_intercept(price, sqm) AS intercept
    FROM base
)
...
~~~

### Map and listings table

Test whether the default mapped population is reasonably small, such as a few thousand rows. If so, return the fields needed by both map and table and reuse one result through Grafana transformations. If the map payload becomes large, retain separate queries. Do not increase browser/network payload to remove a negligible database query.

### Acceptance criteria

- grafana/olx-overview.json uses overview_listings_filtered() for migrated current-market panels.
- Headline KPIs use one PostgreSQL request.
- Price-cut statistics use one PostgreSQL request.
- Sales segmentation builds its filtered population once.
- Scatter and regression use one PostgreSQL request.
- Map/table sharing is used only when payload size remains reasonable.
- Dashboard output remains semantically equivalent.
- Query count and total dashboard work improve against the baseline.

### Agent prompt

~~~text
Work only on Stage 4 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md, starting with grafana/olx-overview.json and the reporting SQL it uses.

Migrate the overview's current-market queries to reporting.overview_listings_filtered(). Consolidate the four headline KPI requests into one SQL request returning active, new_7d, median sale KM/m², and median rent. Consolidate price-cut count and median biggest reduction into one request. Add a reporting overview_sale_segments query/function that materializes one filtered sale base and returns dimension, bucket, count, median, p25, and p75 for the relevant segment dimensions. Combine scatter and regression into one query with listing/fit series. Evaluate whether map and mapped-listings table can safely share one result; keep separate queries if the payload would become large.

Preserve all existing Grafana output, aliases, null behavior, filter semantics, date windows, and panel behavior. Do not change historical filtering in this stage. Compare query count and total dashboard refresh time with the Stage 1 baseline. Add focused tests or SQL comparisons for each migrated query. Do not optimize unrelated dashboards or add caching.
~~~

---

## Stage 5 — Rewrite historical filtering around physical OLAP facts

### Objective

Make the main historical query read physical analytical facts directly instead of joining back to operational/history structures.

### Required data

Ensure olap.daily_listing_facts directly contains everything needed by market_daily_filtered():

~~~text
day
article_id
category
category_memberships
deal
sqm
room_bucket
neighborhood
price_state
ppm2
membership_inferred
attributes_inferred
stale_observation
provisional_day
~~~

The existing schema and naming take precedence; add only fields required by the current API and semantics.

### Function rewrite

Rewrite public.market_daily_filtered(), or the repository's equivalent schema-qualified function, to read olap.daily_listing_facts directly rather than reporting.daily_listing_facts.

Preserve the existing filtering API for category, minimum/maximum area, rooms, deal, and neighborhood. The desired path is:

~~~text
Grafana
  ↓
reporting.market_daily_filtered()
  ↓
olap.daily_listing_facts only
~~~

Verify that inferred attributes, stale observations, provisional days, price state, and category membership semantics remain unchanged.

### Acceptance criteria

- Historical overview queries no longer require unnecessary joins to operational tables.
- The existing function API and output semantics are preserved.
- 30-day and 90-day historical benchmarks improve, or the plans explain why they do not.
- Required denormalization is populated by the existing OLAP publication/reconciliation path.

### Agent prompt

~~~text
Work only on Stage 5 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md.

Inspect market_daily_filtered, reporting.daily_listing_facts, physical olap.daily_listing_facts, partition publication/reconciliation code, and historical Grafana panels. Ensure the physical daily OLAP facts contain the fields needed by the existing filtering API, using repository naming and existing semantics.

Rewrite the historical filtering path so the function reads olap.daily_listing_facts directly rather than joining unnecessarily to operational/history structures. Preserve the current API and semantics for category, area bounds, rooms, deal, neighborhood, inferred fields, stale observations, provisional days, and price state.

Do not add indexes yet; Stage 6 is for plan-driven indexes. Capture before/after EXPLAIN (ANALYZE, BUFFERS, SETTINGS) for 30-day and 90-day historical queries, run historical correctness comparisons, and report any remaining joins and their justification.
~~~

---

## Stage 6 — Add only justified indexes and refresh statistics

### Objective

Improve specific verified access paths without creating oversized indexes or unnecessary write/maintenance costs.

### Historical indexes

Add indexes only after Stage 5 produces real plans.

The existing partition index begins with:

~~~text
(deal, property_type, neighborhood, room_bucket, day)
~~~

Because the overview historical query does not filter property_type, test a dashboard-specific index such as:

~~~sql
CREATE INDEX ... ON olap.daily_listing_facts_YYYY_MM
    (deal, room_bucket, neighborhood, day);
~~~

If category memberships are arrays, test:

~~~sql
CREATE INDEX ... ON olap.daily_listing_facts_YYYY_MM
USING gin (category_memberships);
~~~

Wire accepted indexes into ensure_analytics_partitions() so new partitions receive them automatically. Do not manually index only existing partitions.

### Current-listing indexes

Keep existing useful indexes:

~~~sql
CREATE INDEX listings_active_idx
ON olap.listings (is_rent, last_seen)
WHERE closed_at IS NULL;
~~~

~~~sql
CREATE INDEX listing_categories_filter_idx
ON olap.listing_categories (category, article_id);
~~~

If room filtering is a meaningful selector, test a room/deal index. If normalized physical columns exist, prefer:

~~~sql
CREATE INDEX listings_active_dashboard_idx
ON olap.listings (deal, room_bucket, last_seen DESC)
WHERE closed_at IS NULL;
~~~

Do not create a large combined index containing every possible filter without evidence.

### Statistics after publication

At the end of successful OLAP publication/reconciliation, run targeted refreshes:

~~~sql
ANALYZE olap.listings;
ANALYZE olap.listing_categories;
~~~

Also analyze affected daily partitions. Do not run full-database VACUUM ANALYZE after every scrape.

### Acceptance criteria

- Every new index is justified by an execution plan or benchmark.
- Partition index creation is part of the partition-management path.
- New indexes improve target queries without unacceptable publication/write cost.
- Targeted ANALYZE runs after substantial OLAP publication/rebuild operations.

### Agent prompt

~~~text
Work only on Stage 6 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md.

Use Stage 5 execution plans to identify actual historical and current-listing bottlenecks. Add only indexes that demonstrably improve verified queries. Consider the dashboard-specific daily fact index (deal, room_bucket, neighborhood, day), a GIN category_memberships index where applicable, and current-listing room/deal indexes only when plans justify them. Prefer physical normalized columns over expression indexes when those columns exist.

Integrate accepted daily indexes into ensure_analytics_partitions() so future partitions receive them. Keep existing useful indexes. Add targeted ANALYZE for olap.listings, olap.listing_categories, and affected daily partitions after successful OLAP publication/reconciliation; do not add full VACUUM ANALYZE after every scrape.

For every index, capture before/after plans, latency, and write/publication impact. Reject indexes without measurable benefit. Run migration, partition, and relevant query tests.
~~~

---

## Stage 7 — Verify semantic correctness

### Objective

Prove that SQL refactors and dashboard query consolidation preserve existing results.

### Required filter combinations

Compare old and new outputs for:

- All filters
- Sale
- Rent
- One category
- One room bucket
- Multiple neighborhoods
- Minimum area only
- Maximum area only
- Area range
- Category + rooms
- Category + neighborhood
- Category + deal + area + rooms + neighborhood

### Required result comparisons

Compare at least:

- Active count
- New 7d
- Sale median ppm²
- Rent median
- Room counts
- Price-reduction statistics
- Segment medians
- Neighborhood counts
- Map article IDs
- Historical daily inventory
- Historical p25/p50/p75

Results must be identical except for a documented bug intentionally being fixed. Add automated SQL regression tests if the repository already has database-test infrastructure. Otherwise add reproducible SQL comparisons consistent with project conventions.

### Acceptance criteria

- All required filter combinations have old/new comparisons.
- Differences are zero or documented and intentionally approved.
- Current and historical results are both covered.
- The overview dashboard loads successfully with every tested filter combination.

### Agent prompt

~~~text
Work only on Stage 7 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md: semantic regression testing.

Inspect existing database-test and fixture conventions. Build automated comparisons where possible; otherwise add reproducible SQL comparison checks. Compare old and new paths across all required filter combinations: all filters, sale, rent, one category, one room bucket, multiple neighborhoods, min area, max area, area range, category+rooms, category+neighborhood, and category+deal+area+rooms+neighborhood.

Compare active count, new_7d, sale median ppm², rent median, room counts, price-reduction results, segment medians, neighborhood counts, map article IDs, historical daily inventory, and historical p25/p50/p75. Include null handling, empty selections, no-pin/unmapped values, and date-window behavior.

Do not make performance changes in this stage. Treat every difference as a failure until it is explained as an intentional documented bug fix. Run relevant tests and report exact discrepancies and their disposition.
~~~

---

## Stage 8 — Rebenchmark, decide, and stop based on evidence

### Objective

Measure the cumulative result, isolate the value of each major stage, and retain only changes that improve the real dashboard workload.

Before each major comparison:

~~~sql
SELECT pg_stat_statements_reset();
~~~

Refresh the dashboard repeatedly and compare with the Stage 1 baseline:

| Change | Expected improvement |
| --- | --- |
| Resource allocation | All SQL |
| Grafana connection limit | Contention and dashboard wall time |
| Filter-options table | Initial dashboard load |
| Canonical filter function | Current-market queries |
| KPI consolidation | Query count |
| Segment consolidation | CPU and query count |
| Historical denormalization | Trend panel |
| Plan-driven indexes | Specific verified queries |

Do not use application caching yet. At this scale, the database should serve the dashboard efficiently once PostgreSQL has adequate CPU, historical fact scans are removed from variables, all current filters are applied in the base function, repeated populations are consolidated, and historical queries avoid unnecessary operational joins.

A current-market query taking approximately 100 ms after these changes is evidence to inspect structure and plans further; it is not an automatic reason to add caching.

### Recommended final resource state

Use these values only if benchmarks support them:

| Component | CPU limit | RAM limit |
| --- | ---: | ---: |
| PostgreSQL | 1.25 | 2 GB |
| Grafana | 0.5 | 768 MB |
| Scraper | 0.5 | 512 MB |
| Maintenance | 0.5 | 512 MB |
| OLAP reconcile | 0.5 | 512 MB |
| Backup | Small/default | 256 MB |

PostgreSQL:

~~~text
shared_buffers = 512MB
effective_cache_size = 1536MB
work_mem = 8MB
maintenance_work_mem = 128MB
max_connections = 40
~~~

Grafana:

~~~yaml
maxOpenConns: 8
maxIdleConns: 4
~~~

### Acceptance criteria

- Final dashboard is measurably better than baseline, or the remaining bottleneck is clearly identified.
- Query count, complete-dashboard wall time, database CPU, and expensive-query work are compared.
- Retained changes have measured or plan-supported rationale.
- Reverted changes are documented.
- The 2-OCPU/12-GB deployment constraint is preserved.
- No premature cache or infrastructure expansion was introduced.

### Agent prompt

~~~text
Work only on Stage 8 of docs/GRAFANA-PERFORMANCE-OPTIMIZATION-PLAN.md: final evidence-based rebenchmark.

Reset pg_stat_statements before each major comparison, repeatedly refresh the complete overview dashboard, and compare the final state with docs/performance-baseline.md. Measure complete-dashboard wall time, SQL request count, mean/approximate p95 SQL time, database CPU/memory, expensive-query rows, and total execution time. Attribute improvements separately to resource allocation, connection limits, filter options, canonical filtering, KPI consolidation, segment consolidation, historical denormalization, and indexes wherever possible.

Keep only changes that improve the real dashboard workload or are required for correctness/operational safety. Document reverted or inconclusive changes. Confirm that the final resource state remains within the 2-OCPU/12-GB VM and does not starve Grafana, scraping, tunnel, or maintenance. Do not add Redis, external caching, another database, or infrastructure as a substitute for unresolved SQL inefficiency.

Produce a concise final report with baseline versus final metrics, retained configuration, query-count reduction, remaining bottlenecks, and recommended next steps.
~~~

---

## Final handoff checklist

- [ ] Baseline and instrumentation are documented.
- [ ] PostgreSQL resource settings are benchmark-supported.
- [ ] Grafana connection limits are benchmark-supported.
- [ ] Maintenance and reconciliation resource limits are consistent.
- [ ] Dashboard variables use olap.dashboard_filter_options.
- [ ] overview_listings_filtered() applies all current dashboard filters.
- [ ] Overview KPIs and repeated current-market populations are consolidated.
- [ ] Historical filtering reads physical OLAP facts directly where possible.
- [ ] Indexes are plan-justified and future partitions receive required indexes.
- [ ] OLAP statistics are refreshed after publication/rebuild operations.
- [ ] Semantic regression tests pass.
- [ ] Final dashboard metrics are compared with the baseline.
- [ ] Any limitation or reverted optimization is documented.

## Core instruction for the implementation agent

> Optimize for total dashboard load time and total database work, not merely individual query duration. Preserve existing dashboard semantics and the existing 2-OCPU/12-GB deployment. Do not introduce new infrastructure or caching as a substitute for fixing repeated SQL work.

The highest-probability improvements are expected from resource allocation, fact-free dashboard variables, the canonical all-filter current-listing function, KPI/query consolidation, and direct physical OLAP access for historical queries. Keep that expectation subordinate to measurements.
