# Database schema

`init/` is the current schema definition. Numeric prefixes express dependency
order for the PostgreSQL entrypoint and the application migrator.

| File | Responsibility |
|---|---|
| `00-schemas.sql` | Reporting and OLAP schemas |
| `01-oltp-tables.sql` | Current listings, search state, evidence, raw responses, and job state |
| `02-olap-tables.sql` / `02-reporting-state.sql` | Dashboard marts and refresh state |
| `03-table-constraints.sql` | Keys, foreign keys, and table constraints |
| `04-functions.sql` | Ingestion helpers, analytics, geography, and triggers |
| `05-source-views.sql` | Canonical OLTP-to-OLAP source transformations |
| `06-reporting-functions.sql` | Refresh, filtering, comparison, and validation functions |
| `07-views.sql` | Stable reporting views used by Grafana |
| `08-oltp-indexes.sql` / `09-olap-indexes.sql` | Operational and dashboard indexes |
| `10-triggers.sql` | Evidence normalization and analytics invalidation |
| `11-neighborhood-data.sql` | Generated neighborhood seed data |
| `12-seed-state.sql` / `13-reporting-access.sql` | Initial state and reporting grants |
| `14-persona-listing-scopes.sql` | Buyer, renter, and agent filter scopes |
| `15-postgis-neighborhood-boundaries.sql` / `16-rebuild-postgis-neighborhood-index.sql` | PostGIS boundaries, assignment, and spatial index |
| `17-olap-refresh-performance.sql` / `18-olap-targeted-refresh.sql` | Refresh source optimization and dirty-grain publication |
| `19-remove-dashboard-public.sql` / `20-align-olap-health-after-public-schema-removal.sql` | Reporting surface and OLAP health definitions |
| `20-y-data-contract-maintenance-context.sql` | Grants the migration transaction its audited evidence-repair context |
| `20-z-data-contract-preflight.sql` | Repairs legacy evidence before strict data-contract constraints |
| `21-data-contracts-retention.sql` | Mart grains, evidence rules, partitions, retention, and validation |
| `22-widen-evidence-source-domains.sql` through `26-scrape-run-success-index.sql` | Evidence, enrichment, and run-state constraints and indexes |
| `zz-database-roles.sh` | Runtime ownership and reader permissions |

Fresh volumes execute these files in order. The migrator records filenames and
checksums in `schema_migrations`, applies each migration transactionally, and
uses an advisory lock. Do not edit an applied SQL file; add a new migration for
changes that must reach existing databases.

## OLTP and OLAP boundary

The scraper-owned tables in `public` are the system of record: current listing
state, search/run state, raw response evidence, and append-only state and price
events. `listing_daily` is the historical inventory projection.

Physical dashboard-grain tables live in `olap`. Ingestion never writes them
directly. Grafana reads stable views and functions in `reporting`, backed by
the published OLAP snapshot. Source views ending in `_source` define the
canonical transformations and support validation.

`reporting.refresh_dashboard_olap()` publishes a consistent generation of all
marts and records it in `olap.refresh_state`. The maintenance cycle rebuilds
pending daily history, refreshes current-market marts, applies retention, and
validates reporting contracts. Operational health panels read live run and
refresh-control state; analytical panels read published snapshots.

Monthly partitions cover event and daily-history tables. Maintenance creates
upcoming partitions, applies the retention policy, and records validation
results. Evidence updates and deletes are rejected except through the audited
retention path.

## Geography

Neighborhood boundaries are stored as PostGIS `MultiPolygon` geometry in SRID
4326 with a GiST index. `public.neighborhood_of()` uses `ST_Covers` for
containment and a five-kilometre geography-distance fallback. Shared-boundary
matches are deterministic by neighborhood priority and name.

Regenerate the geographic seed with `node geo/scripts/gen-sql.js` from the
repository root. Do not hand-edit generated polygon data.
