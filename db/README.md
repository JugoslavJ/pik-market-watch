# Database schema

`init/` is the current schema definition. The canonical baseline is split into
ordered, responsibility-oriented SQL files for both the PostgreSQL entrypoint
and the application migrator; the role bootstrap remains a separate shell
script because it needs environment-provided credentials.

| File | Responsibility |
|---|---|
| `00-core-schemas.sql` | Reporting and OLAP schemas |
| `01-tables.sql` | OLTP tables, OLAP marts, and reporting state |
| `02-constraints.sql` | Keys, foreign keys, and table constraints |
| `03-functions.sql` | Ingestion, analytics, geography, and trigger helpers |
| `04-source-views.sql` | Canonical OLTP-to-OLAP source transformations |
| `05-reporting-functions.sql` | Dashboard refresh, filtering, comparison, and validation functions |
| `06-reporting-views.sql` | Stable reporting views used by Grafana |
| `07-indexes.sql` | Operational and dashboard indexes |
| `08-triggers.sql` | Evidence normalization and analytics invalidation |
| `09-neighborhood-data.sql` | Generated neighborhood seed data |
| `10-seed-and-access.sql` | Initial state and reporting grants |
| `11-persona-scopes.sql` | Buyer, renter, and agent filter scopes |
| `12-postgis.sql` | PostGIS boundaries and spatial indexes |
| `13-olap-refresh.sql` | OLAP refresh source optimization and targeted publication |
| `14-reporting-surface.sql` | Final private reporting surface and OLAP health |
| `15-data-contracts.sql` | Evidence contracts, mart constraints, partitions, retention, and validation |
| `16-evidence-integrity.sql` | Currency identity and operational evidence indexes |
| `zz-database-roles.sh` | Runtime ownership and reader permissions |

Fresh volumes execute these files in order. The migrator records each filename
and checksum in `schema_migrations`, applies each file transactionally, and
uses an advisory lock. Existing volumes from the former migration chain are
adopted after a complete-schema fingerprint check; their SQL is not replayed.
For future changes, add a normal forward migration; periodically repeat this
squash process when the chain grows, updating the complete-schema adoption
check if the final schema fingerprint changes.

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
