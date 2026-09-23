# Grafana performance baseline

Captured 2026-09-23 (Europe/Budapest) against the provisioned `OLX.ba Market
Overview` dashboard (`olx-overview`). This is Stage 1 evidence only. No
dashboard SQL, resource limit, index, or query-plan change was made.

## Environment and instrumentation

The existing named PostgreSQL volume was already populated. Before the change
it reported PostgreSQL 16.9, an empty `shared_preload_libraries`,
`track_io_timing=off`, and no `pg_stat_statements` extension. After the
instrumentation change:

| Check | Observed value |
| --- | --- |
| PostgreSQL | 16.9 (PostGIS 16-3.5 compatibility image used for this volume) |
| `shared_preload_libraries` | `pg_stat_statements` |
| `track_io_timing` | `on` |
| Extension | `pg_stat_statements` 1.10 |
| Migration ledger | `12-pg-stat-statements.sql` applied |
| PostgreSQL limit | 0.50 CPU, 768 MiB / 768 MiB swap (unchanged) |
| Current listings | 2,120 |
| Historical facts | 125,922; 2020-11-09 through 2026-09-22 |

The checked-in Compose file requests a PostgreSQL 18 image, but the existing
volume is PostgreSQL 16 data. Recreating the Compose database container with
that image failed with the image's major-version data-layout guard. For the
measurements below, the volume was run with the already available PostgreSQL
16/PostGIS image and the Stage 1 command settings. The volume was not removed
or recreated. A PostgreSQL 18.6 volume/container is now active; the rerun is
reported separately below.

The extension was installed through the project migrator. Because PostgreSQL
does not permit the least-privileged `olx_migrator` role to create this
extension, the dedicated migrator performs a narrowly scoped bootstrap-admin
preflight; the idempotent SQL file is then applied and recorded in
`schema_migrations`.

## Measurement method

The target replay used Grafana's authenticated `/api/ds/query` endpoint with
the SQL from `grafana/dashboards/olx-overview.json`. The current-market cases
replayed the active-listings aggregate with the corresponding filters; the
historical cases replayed the daily trend target. Each target was issued as a
separate request and `pg_stat_statements` was reset before each case.

These are per-target timings, not complete browser dashboard-load timings.
The first attempt to submit all overview targets in one batch caused the
768 MiB PostgreSQL container to restart during the default refresh. A serial
complete-target replay then stalled after a partial run and was stopped. No
complete-refresh result is claimed below.

`pg_stat_statements` mean time is the database execution time for the target;
Grafana target time includes the Grafana HTTP/proxy path. The one-call cases
do not provide a reliable p95. PostgreSQL's statement view stores aggregate
min/max/mean values, not per-call samples, so an approximate SQL p95 was not
measured.

## Required workload results

| Workload | Grafana target ms | SQL ms | SQL calls | SQL result rows | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| Default filters, 90-day dashboard range | 629.3 | 17.759 | 1 | 1 | Per-target proxy |
| Sale only | 58.1 | 9.805 | 1 | 1 | Per-target proxy |
| Rent only | 32.6 | 8.830 | 1 | 1 | Per-target proxy |
| One category (`apartments`) | 82.4 | 39.556 | 1 | 1 | Per-target proxy |
| One neighborhood (`Centar 1`) | 52.0 | 10.767 | 1 | 1 | Per-target proxy |
| One room bucket (`2`) | 49.2 | 17.172 | 1 | 1 | Per-target proxy |
| Category + neighborhood + rooms | 68.4 | 7.276 | 1 | 1 | Per-target proxy |
| Historical range, 30 days | 8,535.0 | 8,525.122 | 1 | 30 | Per-target proxy |
| Historical range, 90 days | 9,470.3 | 9,466.949 | 1 | 90 | Per-target proxy |

The following complete-dashboard metrics were unavailable in the initial
PostgreSQL 16 attempt:

| Metric | Result |
| --- | --- |
| Complete dashboard load time | Not measured; all-target batch caused a PostgreSQL restart and the serial replay stalled |
| Complete-dashboard SQL request count | Not measured |
| Complete-dashboard mean SQL time | Not measured |
| Complete-dashboard approximate p95 SQL time | Not measured |
| Complete-refresh database CPU/memory | Not measured; only target-level samples were possible |

## PostgreSQL 18 rerun

Rerun on 2026-09-23 with PostgreSQL 18.6, the same dashboard JSON, filters,
time ranges, Stage 1 instrumentation, and unchanged 0.50-CPU/768-MiB database
limit. The live scraper added two current listings and historical facts changed
from the first capture while the rerun was performed (2,122 current listings;
127,513 historical facts). The serial complete-target replay completed all
cases with 29 SQL requests per refresh and zero datasource errors. These are
still API replay times rather than browser-concurrent wall times.

| Scenario | Replay ms | Approx. p95 SQL ms | SQL requests | Rows returned | DB CPU max | DB memory max |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Default, 90d | 5,232.5 | 885.797 | 29 | 2,187 | 49.65% | 281.4 MiB (36.64%) |
| Sale only, 90d | 5,215.2 | 929.859 | 29 | 1,739 | 51.12% | 291.4 MiB (37.94%) |
| Rent only, 90d | 4,016.0 | 757.589 | 29 | 904 | 50.20% | 295.0 MiB (38.41%) |
| One category, 90d | 10,717.9 | 1,307.573 | 29 | 1,780 | 50.04% | 296.4 MiB (38.59%) |
| One neighborhood, 90d | 12,338.1 | 1,508.773 | 29 | 889 | 51.66% | 298.1 MiB (38.82%) |
| One room bucket, 90d | 11,423.2 | 1,240.960 | 29 | 1,068 | 50.03% | 298.5 MiB (38.87%) |
| Category + neighborhood + rooms, 90d | 9,703.0 | 1,473.162 | 29 | 590 | 50.85% | 299.2 MiB (38.96%) |
| Default, 30d | 9,888.2 | 1,440.634 | 29 | 2,067 | 50.57% | 299.0 MiB (38.93%) |

The identical isolated-target comparison was:

| Case | PostgreSQL 16 SQL ms | PostgreSQL 18 SQL ms | PostgreSQL 16 Grafana ms | PostgreSQL 18 Grafana ms |
| --- | ---: | ---: | ---: | ---: |
| Default active target | 17.759 | 7.506 | 629.3 | 221.6 |
| Sale-only active target | 9.805 | 4.799 | 58.1 | 28.6 |
| Rent-only active target | 8.830 | 4.632 | 32.6 | 16.8 |
| One category active target | 39.556 | 5.213 | 82.4 | 19.0 |
| One neighborhood active target | 10.767 | 2.790 | 52.0 | 16.5 |
| One room bucket active target | 17.172 | 37.818 | 49.2 | 50.6 |
| Category + neighborhood + rooms active target | 7.276 | 2.355 | 68.4 | 14.8 |
| Historical 30d target | 8,525.122 | 5,260.845 | 8,535.0 | 5,275.2 |
| Historical 90d target | 9,466.949 | 6,881.349 | 9,470.3 | 6,896.5 |

Conclusion: the PostgreSQL 18 rerun does not confirm identical timings. The
workload remains pre-optimization, but PostgreSQL 18 is materially faster for
the historical targets and most current targets. The PostgreSQL 16 complete
refresh restart/stall did not reproduce: PostgreSQL 18 completed the serial
target replay without errors or restart.

## `pg_stat_statements` snapshot

The final snapshot was taken after the 90-day historical target, with the
statistics reset immediately before that case. It therefore describes that
target rather than a whole dashboard refresh.

| Normalized statement | Calls | Total ms | Mean ms | Min ms | Max ms | Rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `reporting.market_daily_filtered(...)` trend query | 1 | 9,466.95 | 9,466.95 | 9,466.95 | 9,466.95 | 90 |
| `public.dashboard_numeric(p_value)` | 2 | 0.15 | 0.07 | 0.01 | 0.13 | 2 |

During the partial all-target attempt, the variable queries were also
observed in the statement view: Rooms took 5,525.25 ms for 6 rows and Category
took 5,218.05 ms for 3 rows. Those values are retained as partial evidence,
not complete-refresh metrics.

After the PostgreSQL 18 rerun, the final reset window was the default 30-day
scenario. Its top statements were:

| Normalized statement | Calls | Total/mean ms | Rows |
| --- | ---: | ---: | ---: |
| `reporting.market_daily_filtered(...)` trend query | 1 | 4,852.17 / 4,852.17 | 31 |
| Rooms variable query | 1 | 1,772.76 / 1,772.76 | 6 |
| Weekly comparison query | 1 | 942.45 / 942.45 | 1 |

## Representative plans

All plans used `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` with the existing
settings. The current representative query used all categories, all deals,
all room buckets, no neighborhood restriction, and the default 0–99,999 m²
range.

### Current active-listings aggregate

```text
Aggregate  (actual time=81.605..81.607 rows=1 loops=1)
  Buffers: shared hit=3479
  -> Function Scan on listings_filtered
       (actual time=65.459..81.320 rows=1150 loops=1)
     Filter: deal and room_bucket filters
     Rows Removed by Filter: 137
     Buffers: shared hit=3479
Settings: effective_cache_size = '512MB', work_mem = '8MB',
  random_page_cost = '1.1', effective_io_concurrency = '200'
Planning Time: 5.762 ms
Execution Time: 81.873 ms
```

### Historical trend, 30 days

```text
Sort  (actual time=9166.761..9166.771 rows=31 loops=1)
  Sort Method: quicksort  Memory: 27kB
  Buffers: shared hit=5146325
  -> Function Scan on market_daily_filtered
       (actual time=9166.621..9166.657 rows=31 loops=1)
     Buffers: shared hit=5146322
Settings: effective_cache_size = '512MB', work_mem = '8MB',
  random_page_cost = '1.1', effective_io_concurrency = '200'
Planning Time: 2.676 ms
Execution Time: 9168.859 ms
```

### Historical trend, 90 days

```text
Sort  (actual time=14291.870..14291.877 rows=91 loops=1)
  Sort Method: quicksort  Memory: 33kB
  Buffers: shared hit=7477074
  -> Function Scan on market_daily_filtered
       (actual time=14291.740..14291.790 rows=91 loops=1)
     Buffers: shared hit=7477071
Settings: effective_cache_size = '512MB', work_mem = '8MB',
  random_page_cost = '1.1', effective_io_concurrency = '200'
Planning Time: 2.185 ms
Execution Time: 14292.712 ms
```

The same plans were rerun on PostgreSQL 18.6 after the matrix. Plan shape and
settings remained unchanged; the observed execution figures were:

| Plan | Actual rows | Shared-buffer hits | Planning ms | Execution ms |
| --- | ---: | ---: | ---: | ---: |
| Current active-listings aggregate | 1,146 (134 removed) | 980 | 4.307 | 17.232 |
| Historical trend, 30 days | 31 | 4,616,550 | 2.832 | 13,412.739 |
| Historical trend, 90 days | 91 | 6,711,851 | 3.236 | 15,124.606 |

The PostgreSQL 18 plans retained the existing `effective_cache_size=512MB`,
`work_mem=8MB`, `random_page_cost=1.1`, and
`effective_io_concurrency=200` settings. Direct `EXPLAIN ANALYZE` timings are
not substituted for the Grafana target timings because they are separate
requests and include plan/instrumentation overhead.

The historical function's actual output row counts were 31 and 91 in the
direct `EXPLAIN` runs because the date bounds are inclusive; the Grafana
target replay returned 30 and 90 rows for its `now-30d` and `now-90d` macro
expansion.

## Docker stats during target execution

These samples were collected during one live 90-day historical target, not a
complete dashboard refresh:

| Container | CPU samples | Memory samples |
| --- | --- | --- |
| PostgreSQL | 0.01%, 0.00%, 0.02% | 148.5–148.6 MiB / 768 MiB (19.34–19.35%) |
| Grafana | 2.93%, 1.59%, 9.59% | 274.3–274.7 MiB / 768 MiB (35.72–35.77%) |

The failed all-target batch restarted PostgreSQL before a valid complete-
refresh `docker stats` series could be collected. The database recovered and
remained healthy for the individual target measurements.

For the PostgreSQL 18 serial replay, `docker stats` samples taken by the
harness reached 49.65–51.66% database CPU and 281.4–299.2 MiB database
memory (36.64–38.96% of the limit). A final point sample was 0.00% CPU and
299.3 MiB for PostgreSQL, and 2.69% CPU and 470.7 MiB for Grafana.

## Verification and limitations

Completed verification:

- Compose configuration validation passed.
- The dedicated migrator applied `12-pg-stat-statements.sql` to the existing
  volume.
- PostgreSQL settings and extension presence were verified with SQL.
- Grafana health returned `database: ok`; the overview dashboard API returned
  32 panels.
- The required per-target filter/range matrix completed with no datasource
  errors.
- Representative plans and target-level `docker stats` were captured.
- The PostgreSQL 18 rerun completed all eight serial target replays with 29
  SQL requests each and no datasource errors.

Limitations:

- No browser automation was available, so complete-dashboard wall time was
  replayed through Grafana's datasource API rather than measured in a browser.
- The initial PostgreSQL 16 all-target refresh was not successful under the
  existing 0.50-CPU/768-MiB allocation; the restart/stall is recorded as a
  baseline finding. PostgreSQL 18 completed the serial replay, but browser
  concurrency was not available for either run.
- Grafana emitted an unrelated existing alert-query error because
  `${SCRAPE_STALE_AFTER_HOURS}` remained literal in the provisioned alert
  query. It was not changed in Stage 1.

## Stage 2 — Resource and concurrency allocation

Applied on 2026-09-23. The database kept the existing named volume. Compose
validation passed, PostgreSQL was recreated with the target limits/settings,
and Grafana was recreated to load its updated datasource provisioning.

| Service/settings | Selected value |
| --- | --- |
| PostgreSQL CPU | 1.25 CPU |
| PostgreSQL memory / swap | 2 GiB / 2 GiB |
| `shared_buffers` | 512 MB |
| `effective_cache_size` | 1,536 MB |
| `work_mem` | 8 MB |
| `maintenance_work_mem` | 128 MB |
| `max_connections` | 40 |
| `random_page_cost` | 1.1 (preserved) |
| `effective_io_concurrency` | 200 (preserved) |
| `checkpoint_completion_target` | 0.9 (preserved) |
| `wal_compression` | enabled (preserved; PostgreSQL reports `pglz`) |
| Grafana datasource pool | 8 open / 4 idle |
| Scraper, migrator, maintenance, OLAP reconciliation | 0.50 CPU; 512 MB memory / swap each |

The live PostgreSQL settings were checked through `pg_settings`; the unit for
buffer counts is 8 kB, so the reported count corresponds to the configured
512 MB and 1,536 MB sizes. PostgreSQL reported `max_connections=40`,
`work_mem=8192kB`, `maintenance_work_mem=131072kB`, and the preserved planner,
I/O, checkpoint, and WAL settings. Compose resolves the shared scraper runtime
anchor for scraper, migrator, maintenance, and olap-reconcile, so all four
receive the same container caps. The scraper already had the same explicit
limits; they now come from the shared anchor.

### CPU comparison

The existing `scripts/measure-performance-baseline.ps1` replayed all provisioned
overview variables and panel targets at each CPU limit: one refresh for each
of eight filter/range scenarios, 29 SQL requests per refresh. It sends targets
serially through Grafana's datasource API, matching the Stage 1 method. These
are one-run measurements, not browser wall time or concurrent dashboard
rendering. Each run had zero datasource errors and returned the same row counts
as Stage 1. Limits were tested at 1.25, 1.00, then 1.50 CPU; CPU percentages
and timings are subject to host load and cache/order effects.

| Scenario | 1.00 CPU ms | 1.25 CPU ms | 1.50 CPU ms |
| --- | ---: | ---: | ---: |
| Default, 90d | 5,383 | 2,891 | 6,647 |
| Sale only, 90d | 7,882 | 2,451 | 5,400 |
| Rent only, 90d | 9,258 | 1,988 | 4,942 |
| Apartments, 90d | 4,480 | 4,090 | 5,528 |
| Centar 1, 90d | 10,725 | 4,398 | 5,843 |
| Two rooms, 90d | 6,574 | 4,306 | 4,983 |
| Apartments + Centar 1 + two rooms, 90d | 4,337 | 3,877 | 4,046 |
| Default, 30d | 4,466 | 4,015 | 4,912 |
| Mean of the eight serial replays | 6,638 | 3,502 | 5,288 |

The 1.25-CPU result was fastest on the eight-case mean. The 1.50-CPU run did
not improve complete-target replay time and had the largest observed CPU
sample (106.2% in `docker stats`); it is not selected. At 1.00 CPU the default
90-day replay took 5.38 s and sampled 99.25% database CPU. At 1.25 it took
2.89 s and sampled 96.21% CPU. At 1.50 it took 6.65 s and sampled 105.27%
CPU. Database memory remained approximately 167–207 MiB across the runs.
Given the single run per case and known host contention, these results
support the planned 1.25-CPU starting point but should be repeated after SQL
consolidation for a final tuning decision.

The live limit was restored to 1.25 CPU after the matrix. PostgreSQL settings
and Compose validation were checked again afterward.

### Grafana connection comparison

The configured 8-open/4-idle pool is applied. The 6-versus-8 comparison is
deferred until after the dashboard SQL consolidation work (Stages 3–5), as
specified in the plan. Stage 2 ran before that SQL work; the current dashboard
workload is not the intended post-change basis for selecting the pool size.

Analytics maintenance and OLAP reconciliation share the existing
`pik-market-watch analytics maintenance` advisory lease. Maintenance skips if
the lease is held; reconciliation waits for it and also takes the scrape-cycle
lease. Overlapping analytics jobs therefore do not intentionally execute
concurrently.
