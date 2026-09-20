# Database schema

`init/` is the current schema baseline, not a historical patch archive. The
small numeric prefixes express dependency order for both PostgreSQL's Docker
entrypoint and the application migration runner:

| File                         | Responsibility                                                 |
| ---------------------------- | -------------------------------------------------------------- |
| `00-schemas.sql`             | OLAP and reporting namespaces                                  |
| `01-oltp-tables.sql`         | Operational tables, sequences, defaults, and documentation     |
| `02-olap-tables.sql`         | Physical dashboard marts and OLAP refresh state                |
| `02-reporting-state.sql`     | Private reporting refresh-control state                        |
| `03-table-constraints.sql`   | Primary, unique, and foreign-key constraints                   |
| `04-functions.sql`           | OLTP analytics, parsing, geography, and trigger helpers        |
| `05-source-views.sql`        | Canonical OLTP-to-OLAP transformations and prerequisites       |
| `06-reporting-functions.sql` | Dashboard refresh, filtering, comparison, and parity routines  |
| `07-views.sql`               | Stable private, compatibility, and public reporting views      |
| `08-oltp-indexes.sql`        | Operational and source-transformation indexes                  |
| `09-olap-indexes.sql`        | Dashboard-mart indexes                                         |
| `10-triggers.sql`            | Direct-write normalization and durable OLAP queue triggers     |
| `11-neighborhood-data.sql`   | Generated neighborhood polygon rows                            |
| `12-seed-state.sql`          | Initial singleton and maintenance-control rows                 |
| `13-reporting-access.sql`    | Stable reporting function grants                               |
| `15-postgis-neighborhood-boundaries.sql` | PostGIS neighbourhood boundary rollout and spatial index       |
| `16-rebuild-postgis-neighborhood-index.sql` | Repair the PostGIS boundary GiST operator family after upgrades/restores |
| `17-olap-refresh-performance.sql` | Materialized OLAP intermediates and covering evidence indexes |
| `18-olap-targeted-refresh.sql` | Dirty-day/article source functions and single-pass cycle publication |
| `19-remove-dashboard-public.sql` | Remove the retired public dashboard schema and move sources private |
| `20-align-olap-health-after-public-schema-removal.sql` | Keep OLAP health consistent with retained internal compatibility marts |
| `21-data-contracts-retention.sql` | Mart grains, domain checks, append-only evidence, date partitions, retention, and refresh validation |
| `22-widen-evidence-source-domains.sql` | Extend controlled evidence source domains for supported imports, benchmarks, and fixtures |
| `23-allow-unknown-olap-deal.sql` | Permit explicit unknown deal evidence in OLAP marts |
| `24-price-event-currency-identity.sql` | Include normalized currency in price-event identity |
| `25-enrichment-price-change-index.sql` | Index detail-enrichment price-change probes |
| `26-scrape-run-success-index.sql` | Index recent complete-success lookups by search |
| `zz-database-roles.sh`       | Application ownership and reader permissions                   |

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

Migration 21 provisions monthly inheritance partitions for event/day history,
keeps the existing table/view OIDs stable, and records the policy in
`analytics_partition_policy` and `analytics_retention_policy`. The maintenance
cycle creates upcoming partitions, removes expired partitions/legacy rows, and
records the result of `reporting.validate_olap_contracts()` after publication.
Evidence updates/deletes are rejected by the database; retention is the audited
exception path.

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
