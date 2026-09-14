# Database schema

`init/` is the current schema baseline, not a historical patch archive. The
small numeric prefixes express dependency order for both PostgreSQL's Docker
entrypoint and the application migration runner:

| File                                         | Responsibility                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `00-tables.sql`                              | Tables, constraints, column documentation, initial refresh scope                  |
| `01-indexes.sql`                             | Indexes                                                                           |
| `02-neighborhoods.sql`                       | Generated geographic table, polygons, and lookup functions                        |
| `03-functions.sql`                           | Analytics helpers and trigger functions                                           |
| `04-views.sql`                               | Current evidence and dashboard views                                              |
| `05-filters.sql`                             | Dashboard input parsing and filter functions                                      |
| `06-rebuild.sql`                             | Bulk daily reconstruction                                                         |
| `07-triggers.sql`                            | Direct-write triggers                                                             |
| `08-dashboard-public.sql`                    | Allowlisted read-only reporting views for external dashboards                     |
| `09-analytics-progress.sql`                  | Prefix-safe dirty-range consumption for chunked rebuilds                          |
| `10-raw-retention.sql`                       | Three-day expiry default and resumable transition/outcome state                   |
| `11-raw-archive-format.sql`                  | Versioned one-body raw archive contract                                           |
| `12-publication-history.sql`                 | Durable publication evidence and history contract                                 |
| `13-reporting-surface.sql`                   | Stable private reporting views over the current contract                          |
| `14-exit-economics.sql`                      | Indexed per-listing economics for the exits dashboard                             |
| `15-dashboard-query-review.sql`              | Price-transition lookup optimization, lifecycle indexes, and per-search freshness |
| `16-listing-comparison.sql`                  | Current-market comparison and scoring transformations                             |
| `17-persona-history.sql`                     | Historical persona-dashboard transformations                                      |
| `18-reporting-function-access.sql`           | Reporting helper access contract                                                  |
| `19-current-market-olap.sql`                 | Current-market physical snapshot                                                  |
| `20-comparables-olap-contract.sql`           | Comparable-row compatibility contract                                             |
| `21-dashboard-olap.sql`                      | Dedicated OLAP schema, dashboard marts, and atomic refresh                        |
| `22-incremental-dashboard-olap.sql`          | Dirty-day and changed-article OLAP publication                                    |
| `23-olap-parity-stability.sql`               | Stable-field parity for clock-derived lifecycle ages                              |
| `24-lifecycle-age-dirty-set.sql`             | Refresh open cycles only when displayed age changes                               |
| `25-skip-empty-olap-dirty-sets.sql`          | Skip expensive source views when incremental dirty sets are empty                 |
| `26-align-lifecycle-age-dirty-predicate.sql` | Align open-cycle invalidation with whole-day lifecycle age                        |
| `27-overlap-daily-coverage-watermark.sql`    | Protect incremental publication from late daily-rebuild commits                   |
| `28-durable-daily-olap-dirty-queue.sql`      | Durable generation-tagged daily handoff to OLAP publication                       |
| `29-olap-queue-health.sql`                   | Pending-partition age and queue health telemetry                                  |
| `30-stable-olap-health-contract.sql`         | Additive queue health without changing the stable generation contract             |
| `31-indexed-olap-parity.sql`                 | Single-evaluation indexed exact parity audit                                      |
| `zz-database-roles.sh`                       | Application ownership and reader permissions                                      |

Fresh volumes execute these files in order. The migrator subsequently records
their checksums in `schema_migrations`; startup remains transactional and uses
an advisory lock. An unchanged second run is a no-op. Existing ledger entries
for retired files remain as audit records and need not be deleted.

The baseline also supports databases already on the previous current schema
(through the page-manifest and raw-response diagnostics changes), with or without
the bulk rebuild optimization. It replaces current functions/views, adds the
bulk resolution marker if needed, and replaces the old daily triggers. It does
not replay historical data repairs, rewrite listing locations, or rebuild daily
history. Older databases must first upgrade using the pre-squash release; the
baseline rejects unsupported legacy layouts rather than guessing how to repair
them. Do not delete a database volume to deploy this refactor.

## OLTP and OLAP boundary

The scraper-owned tables in `public` are the OLTP system of record: `listings`,
search/run state, raw responses, and append-only state/price evidence. The
reconstructed `listing_daily` table is an internal projection used to build the
dashboard marts.

Physical dashboard-grain tables live in `olap`. They are derived data and must
not be written by ingestion code. Grafana reads the stable views and functions
in `reporting`; those objects are backed by the OLAP tables. Source views ending
in `_source` contain the canonical OLTP-to-OLAP transformations and are useful
for validation, but are not dashboard query targets.

`reporting.refresh_dashboard_olap()` rebuilds all marts in one transaction and
records their common generation in `olap.refresh_state`. The maintenance cycle
calls the compatibility entry point `reporting.refresh_current_market()`, which
now publishes the complete dashboard generation after daily reconstruction.
`reporting.olap_health` exposes generation consistency, maximum age, and total
tracked rows for monitoring. Operational health panels remain live against run
and refresh-control tables by design; analytical panels use only snapshots.

## Future changes

Applied SQL files remain checksum-protected: splitting the baseline does not
make edits to deployed files safe. Add a new forward migration for changes that
must reach existing volumes. Once every supported installation has those changes,
squash again into a new baseline with an explicit adoption path. Git retains the
historical fixes; fresh databases do not need to execute them forever.

Regenerate geographic SQL with `node geo/scripts/gen-sql.js` from the repository
root. Do not hand-edit its polygon data. A geography change on deployed databases
also needs a forward migration. `diagnostics/` contains manually invoked profiling
queries, outside startup. The old daily rebuild implementation lives only under
`scraper/test/fixtures/sql/` as a regression oracle.
