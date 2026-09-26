# Live database benchmark baseline — 2026-09-24

## Environment and method

- Target: configured Docker PostgreSQL database `olx` (`pik-market-watch-db-1`), healthy before the run.
- Database image: `ghcr.io/baosystems/postgis:18-3.6`, pinned digest `sha256:4117c8beae9081e76a23a1577c64d05260a61fb0a3c212f37596054ef4c190d8`.
- Benchmark: `node scripts/benchmark-olap.js` via a one-off scraper container; incremental mode, 3 repetitions, source profiling enabled, validation disabled.
- Source timings use `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. They are full query execution times, not estimates.
- Run completed at `2026-09-24T19:36:21Z`. It published refresh generations 217–219.

## OLAP source profiles

| Source                                      | Execution ms | Planning ms |    Rows | Shared hit blocks | Shared read blocks | Temp written blocks |
| ------------------------------------------- | -----------: | ----------: | ------: | ----------------: | -----------------: | ------------------: |
| `reporting.current_listing_scores_source`   |    41507.903 |     154.163 |   1,262 |         4,444,804 |                  0 |              15,040 |
| `reporting.daily_listing_facts_source`      |    25960.506 |      54.246 | 129,068 |         6,540,751 |                  0 |                   0 |
| `reporting.lifecycle_movements_source`      |    22976.738 |      37.990 |   2,689 |         1,205,929 |                  0 |                   0 |
| `reporting.lifecycle_cycles_source`         |    22660.011 |      43.411 |   2,003 |         1,205,946 |                  0 |                   0 |
| `reporting.comparison_price_changes_source` |    15875.254 |      38.016 |      46 |         2,798,544 |                  0 |               6,580 |
| `reporting.current_comparison_inputs`       |    14257.277 |      26.854 |   1,262 |         1,620,839 |                  0 |                   0 |
| `reporting.exit_cycles_source`              |     1314.765 |      17.859 |     686 |           279,660 |                  0 |                   0 |
| `reporting.resolved_price_evidence`         |      942.428 |      11.349 |  45,219 |         1,279,489 |                  0 |                   0 |
| `v_market_daily_source`                     |      724.643 |      11.001 |   2,146 |            37,708 |                  0 |                   0 |
| `v_listing_exit_economics_source`           |      251.402 |       9.204 |   2,161 |           367,865 |                  0 |                   0 |
| `v_listing_price_changes_source`            |      160.896 |       6.986 |     810 |            86,110 |                  0 |                   0 |
| `reporting.price_reductions_source`         |      148.980 |       4.866 |     464 |            69,829 |                  0 |                   0 |
| `reporting.daily_market_source`             |       90.185 |       1.982 | 129,068 |             4,590 |                  0 |                   0 |
| `reporting.current_listings_source`         |       25.296 |       0.421 |   1,262 |            10,878 |                  0 |                   0 |
| `reporting.freshness_source`                |        0.251 |       0.884 |       3 |                10 |                  0 |                   0 |

All source profiles reported zero shared disk-read blocks, so these measurements ran against cached data. The two largest profiles, `current_listing_scores_source` and `daily_listing_facts_source`, took 41.5 s and 26.0 s respectively. Source profiles also wrote 15,040 and 6,580 temporary blocks for current listing scores and comparison price changes.

## Incremental refreshes

| Iteration | Elapsed ms | Refresh ID | Rows written | Refreshed at             |
| --------: | ---------: | ---------: | -----------: | ------------------------ |
|         1 |      2,120 |        217 |           61 | 2026-09-24T19:36:19.172Z |
|         2 |         76 |        218 |            3 | 2026-09-24T19:36:21.291Z |
|         3 |         71 |        219 |            3 | 2026-09-24T19:36:21.367Z |

The first refresh processed the dirty article set; the following two were near-idle refreshes. State before refresh: 268 dirty articles, 0 dirty days, 45,219 price events, 105,803 state-history rows, and 1,262 active listings.

Final health was good: 9 tracked marts, one consistent generation, fresh refresh state, maximum age 0 seconds, and 273,887 tracked rows. Database size remained 264,828,607 bytes. The run recorded 1,370,192 WAL bytes and a 15,407,354-byte increase in the database's cumulative temporary-file counter.

## Other benchmark harnesses

The repository also has `benchmark:ingestion`, `benchmark:regressions`, and `benchmark-analytics.js`. They were not run against the live database:

- `benchmark:ingestion` commits generated listing, history, event, search, and run records, with no cleanup step.
- `benchmark:regressions` deletes and seeds reserved article ID ranges and writes up to 1.2 million price-event rows.
- `benchmark-analytics.js` can seed synthetic records, rebuild daily analytics, update listings, and publish another OLAP refresh.

These harnesses are documented in code for disposable databases. Their results remain unmeasured in this live baseline; run them on a disposable restore to complete the full repository benchmark inventory.

## Database and logical dump size

Measured on the live database at `2026-09-24T19:41:48Z`, after the OLAP benchmark:

- PostgreSQL database size: **264,828,607 bytes** (about **252.6 MiB**, shown by PostgreSQL as 253 MB).
- Fresh logical dump: **14,416,033 bytes** (about **13.75 MiB**), generated with `pg_dump -Fc` and streamed through a byte counter. This matches the project's compressed custom-format backup method; no extra dump file was retained.
- The dump is about **5.44%** of the physical database size.
- User relation storage totals **235,905,024 bytes** across `public`, `olap`, and `reporting`. The remaining database size includes catalogs, other database-level files, and free space.

Largest physical relations by total size (`pg_total_relation_size`, including indexes and TOAST):

| Schema.relation                        | Total bytes | Heap bytes | TOAST/FSM/VM bytes | Index bytes |
| -------------------------------------- | ----------: | ---------: | -----------------: | ----------: |
| `public.listing_state_history_2026_09` |  29,712,384 | 19,693,568 |             32,768 |   9,986,048 |
| `public.listing_state_versions`        |  19,079,168 | 17,219,584 |             32,768 |   1,826,816 |
| `public.raw_api_responses`             |  15,835,136 |  1,622,016 |         13,967,360 |     245,760 |
| `public.listing_price_events_2026_09`  |  13,000,704 |  8,568,832 |             32,768 |   4,399,104 |
| `olap.daily_listing_facts_2026_09`     |  11,968,512 | 10,059,776 |             40,960 |   1,867,776 |
| `public.listing_daily_2026_09`         |   8,798,208 |  5,562,368 |             32,768 |   3,203,072 |
| `public.spatial_ref_sys`               |   7,307,264 |  7,061,504 |             32,768 |     212,992 |
| `olap.public_daily_market_2026_09`     |   7,225,344 |  4,988,928 |             40,960 |   2,195,456 |
| `olap.daily_listing_facts_2026_08`     |   7,086,080 |  5,898,240 |             40,960 |   1,146,880 |
| `public.listing_daily_2026_08`         |   4,882,432 |  3,211,264 |             32,768 |   1,638,400 |
| `olap.public_daily_market_2026_08`     |   4,046,848 |  2,785,280 |             40,960 |   1,220,608 |
| `public.listings`                      |   3,940,352 |  3,129,344 |             40,960 |     770,048 |

The biggest storage drivers are monthly state history, state-version records, monthly price events, and daily analytics. `raw_api_responses` is notable for its 13,967,360 bytes of TOAST/FSM/VM storage, consistent with retained response payloads. The top two history relations carry substantial indexes; the September daily OLAP fact partition is mostly heap data.

## First optimization pass

The retained response table had 2,002 live rows, 342 estimated dead rows, no records beyond the three-per-URL retention limit, and no identical `payload`/`source_payload` pairs. A bounded-lock `VACUUM (FULL, ANALYZE)` reclaimed dead physical space without removing live records:

| Size measure                  | Baseline bytes | After bytes |              Change |
| ----------------------------- | -------------: | ----------: | ------------------: |
| `public.raw_api_responses`    |     15,835,136 |  13,099,008 | −2,736,128 (−17.3%) |
| Entire database               |    264,828,607 | 262,117,055 |  −2,711,552 (−1.0%) |
| Fresh compressed logical dump |     14,416,033 |  14,416,588 |                +555 |

The physical database measurement after compaction includes the subsequent OLAP refresh. Logical dump size stayed essentially the same because compaction removed dead physical space, not live rows.

The price-change source had been evaluating `reporting.current_comparison_inputs` solely to obtain the active article ID, deal segment, and cycle start. Its replacement derives those three values from active listings and the lifecycle view. On the live data, all 1,262 active listing inputs matched and the old and new price-change views had zero row differences under `EXCEPT ALL` in both directions.

| Query                                       | Baseline execution | After execution | Change |
| ------------------------------------------- | -----------------: | --------------: | -----: |
| `reporting.comparison_price_changes_source` |      11,025.480 ms |      908.151 ms | −91.8% |
| `reporting.current_listing_scores_source`   |      41,507.903 ms |   23,990.577 ms | −42.2% |

The price-change timings were measured back to back in one session with `EXPLAIN ANALYZE`; the score timings were separate source profiles with the same 1,262 output rows and zero shared disk reads. These are individual live measurements, so repeat them under a comparable load before using the percentages as capacity guarantees.

The live migrator applied the optimized view and advanced the canonical schema checksum. The following incremental refresh completed in 1,426 ms, published generation 220, and left the nine-mart generation healthy and consistent. Exact OLAP validation found zero missing or unexpected rows in the three checked marts. The focused disposable-database comparison suite passed all 10 tests.

## Second optimization pass

The daily facts source evaluated the same deal-boundary history check twice per listing: once for price quality and once for rate quality. Both decisions now share one materialized boundary calculation. The live-data candidate returned the same 129,068 rows, with zero `EXCEPT ALL` differences in either direction. A materialized whole-quality CTE was also tried but rejected because it slowed the one-day query and wrote about 85 MiB of temporary data.

With JIT disabled, matching the dashboard refresh function's setting, the optimized daily facts source measured:

| Query                         | Before execution | After live migration | Change |
| ----------------------------- | ---------------: | -------------------: | -----: |
| All 129,068 daily facts       |     7,889.757 ms |         3,941.419 ms | −50.0% |
| Day `2026-09-23`, 1,578 facts |       873.914 ms |           718.357 ms | −17.8% |

These are back-to-back, cache-warm query measurements. The earlier 25,960.506 ms baseline used PostgreSQL's default JIT setting, so it is not directly comparable with these JIT-disabled timings.

The September daily partitions had dead tuples from delete-and-insert refreshes. Bounded-lock `VACUUM (FULL, ANALYZE)` reclaimed their physical space without changing live rows:

| Size measure                       | Before bytes | After bytes |             Change |
| ---------------------------------- | -----------: | ----------: | -----------------: |
| `olap.daily_listing_facts_2026_09` |   11,968,512 |  11,272,192 |           −696,320 |
| `public.listing_daily_2026_09`     |    8,798,208 |   7,585,792 |         −1,212,416 |
| `olap.public_daily_market_2026_09` |    7,225,344 |   6,340,608 |           −884,736 |
| Entire database                    |  262,207,167 | 259,438,271 | −2,768,896 (−1.1%) |

The physical database is now 5,390,336 bytes smaller than the original baseline (−2.0%). The fresh compressed logical dump is 14,416,407 bytes, essentially unchanged from the original 14,416,033 bytes because no live rows were removed. The three daily partitions can accumulate dead space again during future refreshes; this compaction is a measured one-time reclamation.

The daily-quality view migration applied successfully. A subsequent migrator run exited successfully without applying any migration. The live `04-source-views.sql` ledger checksum is `a5d5e39bf6be3fb76027e18969feaf69481a3518025dd0b2bbd405a4abfbc9f0`. OLAP health reported all nine marts on one generation, and exact validation found zero missing or unexpected rows for daily facts, lifecycle cycles, and lifecycle movements. The disposable migration and daily-state integration checks passed all five tests.

## Durable refresh optimization

The incremental dashboard refresh previously deleted and reinserted every `olap.daily_listing_facts` and `olap.public_daily_market` row for a dirty day. It now stages the source rows and preserves stored rows when every column matches. Changed and obsolete rows are still replaced or removed. This prevents repeated heap and index churn on dirty days whose data has not changed.

On the live, stable `2026-09-23` day, both versions processed the same 1,578 fact rows and 1,578 public market rows:

| Incremental refresh |      Elapsed | Fact tuples rewritten | Public market tuples rewritten |
| ------------------- | -----------: | --------------------: | -----------------------------: |
| Previous function   | 2,801.133 ms |                 1,578 |                          1,578 |
| Updated function    | 2,281.518 ms |                     0 |                              0 |

Tuple identities were captured before and after each run. The previous function rewrote all 3,156 rows despite unchanged source values; the updated function retained every tuple and was 18.5% faster in this single matched trial. The function's `rows_written` return value was 61 on both runs, so it was not used as the churn measure. Future runs with changed source rows still update those rows, as verified by the disposable-database integration test. There is no immediate logical-dump size reduction because the same live data remains; the durable gain is avoiding dead tuples and WAL on repeated refreshes.

The new `05-reporting-functions.sql` checksum is `aa37036a35caea6803a70e5ae6aa93eb9e7048c580627d48d0923fe0569c6e9d`. The focused unchanged/changed/removed-row test passed, the five migration tests passed, and all 12 dashboard integration tests passed.

The current-score snapshot was also assessed for the same approach. All 1,262 source rows differ from storage because `benchmark_at` records the latest evaluation time; only 87 rows differ when that field is excluded. Dashboard queries expose this as "evaluated at", so preserving old score rows would change the timestamp's meaning. The score refresh was left as is.

After the incremental-refresh migration, the live migrator ran again as a no-op. OLAP health remained generation-consistent across all nine marts, and exact validation found zero missing or unexpected rows in the three checked marts.

## Upstream daily projection optimization

`public.rebuild_listing_daily_legacy` also deleted and reinserted its target rows before calculating replacements. Its source calculation reads history and price evidence, so it can build a temporary replacement cohort first. The updated function compares the complete resulting row, including resolved state and detail version references, and writes only changed or missing rows. Coverage still advances and marks the day for OLAP publication.

The live `2026-09-23` day initially had 80 genuinely stale values, which the old rebuild updated. A second old-function run provided the stable baseline below; the new-function run followed with identical source values:

| Historical daily rebuild |      Elapsed | Stored rows | Tuples rewritten | Values changed |
| ------------------------ | -----------: | ----------: | ---------------: | -------------: |
| Previous function        | 2,779.683 ms |       1,578 |            1,578 |              0 |
| Updated function         | 2,566.281 ms |       1,578 |                0 |              0 |

The updated function avoided all 1,578 persistent row rewrites and was 7.7% faster in this single matched trial. The function's `rows_written` result was zero for both live runs because inserts route into a monthly child table; tuple identities and full row values were used for the measurement. Disposable tests confirmed that genuinely changed rows are replaced, obsolete rows are removed, and the bulk output still matches the reference implementation.

The live `03-functions.sql` ledger checksum is `563a9421b44891b2e5ee12e7447f722e3f8337ae8c1716a9bbe786b95bcd5378`. The live OLAP refresh consumed the queued day, left all nine marts generation-consistent, and exact validation found zero missing or unexpected rows in the three checked marts. After reclaiming space created by the old-function trial runs, physical database size is 259,487,423 bytes; this cleanup is separate from the recurring write savings above.

## Lifecycle history lookup optimization

Each lifecycle cycle's opening and closing history snapshot previously scanned the same eligible state-history rows independently for scalar fields, category memberships, and JSON attributes. Both snapshots now materialize the eligible rows once per cycle boundary and reuse that slice for the three aggregations. The canonical migrator applied the view replacement to the live database and advanced the `04-source-views.sql` checksum to `040c9988fd295a2e1d865851e70838fc47e4149e9d6ea1e96be32ba651abdd1c`.

The post-change source profile returned 2,003 cycles and used 944,682 shared buffer hits, versus 1,206,740 in the pre-change profile (21.7% fewer). With JIT disabled, matching the dashboard refresh function's setting, the post-change profile took 1,764.198 ms. The post-change JIT-on profile took 16,368.289 ms, while the pre-change JIT-on sample immediately before migration took 14,485.953 ms; those individual elapsed times did not demonstrate an improvement. The query uses fewer buffers, but a repeated matched-load profile is needed before claiming a wall-time gain. Exact row-value parity was not captured for this pass; only the source row count was compared.

## Latest price evidence lookup optimization

The latest-evidence helper used by active listing inputs used to resolve deal state for every historical price event before returning the newest event. It now applies the existing event-source, price-state, and ID tie-break rules while selecting the newest event, then performs the deal-state lookup once for that event. The live migrator applied the helper update and advanced the `04-source-views.sql` checksum to `d141e4241dbf4c05059b85bd0529865524187a5fe7b949a1431d8e8b03a45680`.

With JIT disabled for both profiles, `reporting.current_comparison_inputs` returned the same 1,262 rows and improved from 1,035.720 ms to 566.245 ms (45.3% faster in this pair of runs). Shared buffer hits fell from 1,621,326 to 724,141 (55.3% fewer). The downstream `current_listing_scores_source` profile measured 3,921.394 ms after the change, compared with 4,281.669 ms before it under JIT off; shared buffer hits fell from 3,252,248 to 2,355,063. Both score profiles wrote 940 temp blocks. These are individual cache-warm measurements. Exact row-value parity was not captured. The change replaces a view function only, so it did not materially alter persistent database size.

A live storage scan found 282 estimated dead tuples in `olap.lifecycle_cycles`. With no active database queries and a two-second lock timeout, `VACUUM (FULL, ANALYZE)` reclaimed its unused pages without removing live rows:

| Size measure            | Before bytes | After bytes |              Change |
| ----------------------- | -----------: | ----------: | ------------------: |
| `olap.lifecycle_cycles` |    3,481,600 |   2,146,304 | −1,335,296 (−38.4%) |
| Entire database         |  259,487,423 | 258,217,663 |  −1,269,760 (−0.5%) |

The lifecycle table retained all 2,003 live rows and had zero estimated dead tuples after compaction. This is one-time reclamation; later refreshes can create dead tuples again.

## Daily category normalization reuse

The historical daily facts source normalized each row's category memberships twice: once for the output array and again as input to `comparison_property_type`. It now computes the normalized array once in a lateral subquery and reuses it. PostgreSQL memoized the result for the four distinct membership/category pairs in the live dataset.

With JIT disabled, the full source returned the same 129,068 rows and measured 3,288.165 ms, compared with 3,559.613 ms before the change (7.6% lower in these cache-warm profiles). The one-day profile returned 1,578 rows and measured 629.968 ms, compared with 627.699 ms before; it showed no improvement. Exact row-value parity was not captured, and the change does not alter persistent storage.

## Listing detail version compaction

Storage statistics showed 496 estimated dead tuples in `public.listing_detail_versions`. With no active database queries and a two-second lock timeout, `VACUUM (FULL, ANALYZE)` reclaimed physical space while retaining all 3,023 live rows:

| Size measure                     | Before bytes | After bytes |            Change |
| -------------------------------- | -----------: | ----------: | ----------------: |
| `public.listing_detail_versions` |    3,858,432 |   3,031,040 | −827,392 (−21.4%) |
| Entire database                  |  258,217,663 | 257,406,655 |  −811,008 (−0.3%) |

The table had zero estimated dead tuples after compaction. This is one-time reclamation; future version updates can create dead tuples again.

## Conditional price-state lookup

The resolved price evidence view uses an explicit `dealType` in event provenance when available, and consults state history only when it is missing. The first attempt filtered out explicit-deal events inside a lateral join, but PostgreSQL still ran that lookup for every event. The final view puts the history query in the `CASE` fallback, allowing it to run only for events that need it. The same conditional fallback is used by the latest-evidence helper.

On the live source, the view returned 45,219 rows in both profiles. With JIT disabled, the prior lateral-join plan took 511.335 ms and used 1,279,495 shared buffer hits. The conditional plan took 300.065 ms and used 593,165 shared hits: 41.3% lower elapsed time and 53.6% fewer hits in this matched cache-warm pair. Its history subplan ran 20,224 times, exactly the number of evidence rows without an explicit `dealType`, instead of running for all 45,219 rows. Exact row-value parity was not captured. This view/function change has no material persistent-space effect.

The live `04-source-views.sql` ledger checksum is `70df27b336dcbcc5a9a712191c0c4289af3569d7a5e34165631caddb9367fb3d`.

## Live database benchmark — 2026-09-25

Three sequential, cache-warm `EXPLAIN (ANALYZE, BUFFERS)` profiles were run for each source with JIT disabled. The table reports the median elapsed time and the range across the three runs; row counts, shared buffer hits, and temporary writes were stable across repetitions.

| Source                                    |    Rows | Median elapsed |        Three-run range | Shared buffer hits | Temp blocks written |
| ----------------------------------------- | ------: | -------------: | ---------------------: | -----------------: | ------------------: |
| `reporting.current_listing_scores_source` |   1,262 |   3,617.391 ms | 3,544.998–3,857.317 ms |          1,620,801 |                 940 |
| `reporting.daily_listing_facts_source`    | 129,068 |   2,371.592 ms | 2,344.640–2,376.809 ms |          1,471,390 |                   0 |
| `reporting.resolved_price_evidence`       |  45,219 |     262.830 ms |     262.595–264.795 ms |            593,165 |                   0 |

The score source remains the heaviest of these reads and writes 940 temporary blocks per profile. A session-only 16 MB `work_mem` trial removed those writes but took 3,708.604 ms in its measured run, so no persistent memory setting was changed. These are live cache-warm profiles; the elapsed time is not a cold-cache estimate.

The live database occupied 257,406,655 bytes. The largest relation with estimated dead rows was `public.listings` at 3,940,352 bytes, with 2,161 live and 18 dead tuples. The larger history, event, raw-response, and daily-fact relations reported zero estimated dead tuples, so this snapshot did not identify useful space to reclaim with table compaction. The relation size for `raw_api_responses` was 13,099,008 bytes (2,002 live rows, zero estimated dead tuples).

## Full live OLAP benchmark — 2026-09-24 22:35 UTC

This repeats the original baseline harness on the live `olx` database after the optimizations: `node scripts/benchmark-olap.js`, incremental mode, three repetitions, all source profiles enabled, and validation disabled. The target was `pik-market-watch-db-1` using the pinned `ghcr.io/baosystems/postgis:18-3.6` image. Source profiles use full `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executions with the database's default JIT setting. All profiles reported zero shared read blocks.

### OLAP source profiles

| Source                                      | Execution ms | Planning ms |    Rows | Shared hit blocks | Shared read blocks | Temp written blocks |
| ------------------------------------------- | -----------: | ----------: | ------: | ----------------: | -----------------: | ------------------: |
| `reporting.current_listing_scores_source`   |   25,857.162 |      63.274 |   1,262 |         1,620,767 |                  0 |              15,040 |
| `reporting.lifecycle_movements_source`      |   13,516.990 |      25.628 |   2,689 |           663,755 |                  0 |                   0 |
| `reporting.lifecycle_cycles_source`         |   12,746.974 |      24.216 |   2,003 |           663,772 |                  0 |                   0 |
| `reporting.daily_listing_facts_source`      |    7,976.315 |      19.148 | 129,068 |         1,471,372 |                  0 |                   0 |
| `reporting.current_comparison_inputs`       |    1,685.450 |      23.285 |   1,262 |           689,121 |                  0 |                   0 |
| `reporting.exit_cycles_source`              |      884.632 |      12.472 |     686 |           279,660 |                  0 |                   0 |
| `reporting.comparison_price_changes_source` |      640.022 |      15.094 |      46 |           919,622 |                  0 |               6,580 |
| `v_market_daily_source`                     |      492.000 |       6.014 |   2,147 |            37,522 |                  0 |                   0 |
| `reporting.resolved_price_evidence`         |      293.439 |       5.959 |  45,219 |           593,159 |                  0 |                   0 |
| `v_listing_exit_economics_source`           |      177.109 |       5.909 |   2,161 |           367,865 |                  0 |                   0 |
| `v_listing_price_changes_source`            |      111.667 |       3.920 |     810 |            86,110 |                  0 |                   0 |
| `reporting.price_reductions_source`         |      107.556 |       3.645 |     464 |            69,829 |                  0 |                   0 |
| `reporting.daily_market_source`             |       69.455 |       1.217 | 129,068 |             4,497 |                  0 |                   0 |
| `reporting.current_listings_source`         |       19.493 |       0.612 |   1,262 |            10,878 |                  0 |                   0 |
| `reporting.freshness_source`                |        0.304 |       0.544 |       3 |                10 |                  0 |                   0 |

Compared with the original 2026-09-24 baseline profile, current listing scores took 25.858 s instead of 41.508 s, daily facts took 7.976 s instead of 25.961 s, lifecycle cycles took 12.747 s instead of 22.660 s, and comparison price changes took 0.640 s instead of 15.875 s. These are single cache-warm runs at different database states. The score source still wrote 15,040 temporary blocks; comparison price changes wrote 6,580.

### Incremental refreshes and final health

Before the run there were 36 dirty articles and 0 dirty days, alongside 45,219 price events, 105,803 state-history rows, and 1,262 active listings. The three refreshes published generations 225–227:

| Iteration | Elapsed ms | Refresh ID | Rows written | Refreshed at UTC        |
| --------: | ---------: | ---------: | -----------: | ----------------------- |
|         1 |      1,418 |        225 |           61 | 2026-09-24 22:35:25.431 |
|         2 |         52 |        226 |            3 | 2026-09-24 22:35:26.848 |
|         3 |         50 |        227 |            3 | 2026-09-24 22:35:26.900 |

Final OLAP health was good: 9 tracked marts, one generation, all marts consistent and fresh, maximum age 0 seconds, and 273,887 tracked rows. The run generated 478,224 WAL bytes and 15,407,354 bytes of cumulative temporary-file writes. Database size changed from 257,406,655 to 257,480,383 bytes during the benchmark.

After the run, a fresh custom-format logical dump streamed through a byte counter measured 14,443,977 bytes. This is 5.61% of the 257,480,383-byte physical database size. The dump file was not retained.

## Previously skipped benchmark inventory — 2026-09-25

The three skipped harnesses were run on disposable PostgreSQL restores. The source snapshot was a custom-format dump of the live database; each workload that needed a clean starting state used a separate restored database. The live database was not used for benchmark writes.

### Ingestion

`benchmark:ingestion` ran its default 100, 500, and 1,200-card cohorts. Each cohort used 15 database statements and committed every generated card without drops:

| Cards | Statements | Elapsed | New rows |
| ----: | ---------: | ------: | -------: |
|   100 |         15 |  145 ms |      100 |
|   500 |         15 |  380 ms |      500 |
| 1,200 |         15 |  838 ms |    1,200 |

The query count stayed flat as cohort size grew. The harness output includes generated article IDs; those do not affect the measurements.

### Regression workload

The corrected regression harness seeded 10,000 listings, six history cycles per listing, 20 listing-day and OLAP-fact rows per listing, and 1.2 million price events. Timings below are for the harness's measured statements after seeding:

| Measurement                                                       |   Rows |  Elapsed |
| ----------------------------------------------------------------- | -----: | -------: |
| Unchanged listing update                                          | 10,000 |   328 ms |
| New sighting insert                                               | 10,000 | 3,755 ms |
| Unfiltered 20-day market query                                    |     20 |   281 ms |
| Sale and neighborhood filtered market query                       |     20 |   226 ms |
| Latest price lookup for 10,000 listings across 1.2 million events | 10,000 | 1,101 ms |

The seed itself is not timed by this harness. This run used a clean restore independent of the ingestion and analytics cohorts.

The clean regression clone occupied 572,774,079 bytes after seeding, compared with 237,967,039 bytes for the same restored starting snapshot (+334,807,040 bytes across the regression fixtures). The March–June price-event partitions occupied 223,379,456 bytes in total: 132,751,360 heap bytes and 90,439,680 index bytes. The May `(article_id, effective_at, id)` index occupied 12,681,216 bytes and served 10,004 scans for the 10,000-listing latest-price lookup. This regression workload did not identify a safe index removal.

### Analytics workload

The analytics harness now uses the normalized state-version schema and is available as `npm run benchmark:analytics`. Its default seed is 3,000 listings, 50 days, 600,000 state sightings, and 150,000 price events. On a clean restore, the baseline measured:

| Measurement                         |   Elapsed |
| ----------------------------------- | --------: |
| State lookup with `EXPLAIN ANALYZE` |      7 ms |
| One past-day listing rebuild        |  8,364 ms |
| Incremental OLAP refresh            | 19,384 ms |
| 200-point geography batch           |     10 ms |

The refresh reported 19,323 rows written. The harness times the queries, not the seed. A first attempt after running ingestion and regression on the same clone took 322,824 ms for refresh and is retained only as a mixed-workload observation; it is excluded from the standalone baseline.

### Score-refresh optimization

The score-source plan spent 3,355.750 ms constructing 168 nearest-neighborhood pairs by repeatedly measuring polygon-to-polygon geography distance. A new derived cache stores the exact distance ranking for each eligible neighborhood pair. A statement-level trigger rebuilds it when neighborhood boundaries change; the source function reads the cached ranking.

Validation on the disposable clone found all 2,962 cached pairs equal to the previous function's full output. The current-score rows and stable fields matched apart from one clock-derived `current_cycle_age_days` value that advanced between snapshots. The cache occupies 464 kB. The cached lookup returned all 168 pairs in 3.456 ms, with 421 shared hits and no temp writes.

For an end-to-end comparison, three warm incremental refreshes each marked the same 3,000 synthetic articles dirty. Both clones used JIT off and 8 MB `work_mem`:

| Refresh      |    Median |  Three-run range |
| ------------ | --------: | ---------------: |
| Before cache | 25,272 ms | 20,210–29,640 ms |
| With cache   | 19,031 ms | 16,789–19,495 ms |

The cached refresh median was 24.7% lower in this matched trial. The single full analytics run after the change was slower than the baseline, and its seed and rebuild were also substantially slower; that run is not used for a speed claim. The repeated warm refresh comparison isolates the score-refresh path more closely, while the cache's 464 kB is its measured storage cost.

## Daily market projection storage optimization — 2026-09-25

A live-data comparison found that the 129,068 rows in `olap.public_daily_market` matched an equivalent projection from `olap.daily_listing_facts` exactly: zero rows differed in either `EXCEPT ALL` direction. The duplicate partitioned table occupied 27,131,904 bytes, about 10.5% of the 257,480,383-byte database. Repository and role configuration show the retired public datasource has no active query path to this internal mart.

The migration removes the duplicate relation and its full and incremental refresh writes. Consumers use `olap.daily_listing_facts` directly; no compatibility view remains. The migration was applied on 2026-09-25. `VACUUM FULL` reclaimed about 2 MB from other relations with dead tuples; the removed partitioned table had occupied 27,131,904 bytes. Performance after the change has not yet been measured.

## Current-schema cleanup — completed 2026-09-26

The scraper now obtains its rebuild interval from one call to `analytics_daily_rebuild_window()`. The database owns the calendar and coverage rules; the application only divides the returned interval into bounded batches. Three alternating query profiles on a disposable live-data restore, with JIT disabled, measured:

| Rebuild-window query                           | Median execution |    Three-run range |
| ---------------------------------------------- | ---------------: | -----------------: |
| Repeated window calculation and fallback scans |       101.604 ms | 100.761–135.673 ms |
| Single database window calculation             |        45.710 ms |   44.363–46.227 ms |

The median was 55.0% lower in this trial. The first baseline run included 222 shared disk-read blocks; subsequent reads were warm. These timings measure interval selection, not the daily rebuild or an entire scrape.

Completed price-history and publication backfills, duplicate-body conversion, transition-marker tables, unused geometry helpers, and redundant daily-fact views were removed. The daily range helper has a descriptive name, migration startup loads its ledger in one query, and comments describe current behavior. Stored historical price provenance remains intact. Batched raw-detail diagnostics now consistently omit response bodies, and successful archives retain the original response.

Grafana provisions one dashboard directory and updates its datasource in place. Its password uses the single-expansion environment syntax, preserving literal dollar signs. This follows [Grafana's provisioning rules](https://grafana.com/docs/grafana/latest/administration/provisioning/).

The cleanup was checked on a restored database before local application. Its base schema matched a fresh installation, excluding generated monthly partitions, ownership, and grants. The comparison also caught and corrected a partition-helper branch referring to the removed daily-market table and stale database comments. The live application ran in one checksum-guarded transaction: all 130,639 daily fact rows matched under `EXCEPT ALL` in both directions, and counts of listings, state history, price events, publication evidence, imported prices, and raw responses were unchanged. A pre-cleanup custom-format backup is retained locally at `backups/current-cleanup/before.dump` (14,036,569 bytes).

Validation passed: 156 unit tests, the full database integration suite, the affected integration suites after final cleanup, ESLint, and Markdown links. A subsequent local migrator run was a no-op. The live OLAP refresh at `2026-09-26T15:32:46.476226Z` published generation 231 with all nine marts fresh and consistent. Exact validation found zero missing or unexpected rows in daily facts (130,639), lifecycle cycles (2,034), and lifecycle movements (2,762). The local scraper image was rebuilt, Grafana was recreated successfully, and its datasource health endpoint returned `Database Connection OK`.

Existing installations must match the current canonical checksums or receive a verified current-schema restore; startup does not replay historical upgrade branches. This pass updates the local stack.
