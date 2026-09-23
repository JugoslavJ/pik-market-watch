# Database schema

`init/` is the canonical current schema. The SQL is split by dependency and
responsibility for readability, but every file describes the same installable
state; there are no forward migrations or later override files in this
directory.

| File | Responsibility |
|---|---|
| `00-core-schemas.sql` | Required extensions and application schemas |
| `01-tables.sql` | OLTP tables, OLAP marts, control tables, and sequences |
| `02-constraints.sql` | Keys, foreign keys, and table constraints |
| `03-functions.sql` | Ingestion, analytics, geography, partition routing, and trigger helpers |
| `04-source-views.sql` | Canonical OLTP-to-OLAP source transformations |
| `05-reporting-functions.sql` | Dashboard refresh, filtering, comparison, and validation functions |
| `06-reporting-views.sql` | Stable reporting views used by Grafana |
| `07-indexes.sql` | Operational, spatial, and dashboard indexes |
| `08-triggers.sql` | Evidence normalization and analytics invalidation |
| `09-neighborhood-data.sql` | Generated neighborhood seed data |
| `10-seed-and-access.sql` | Initial control rows and reporting grants |
| `11-postgis.sql` | Derived neighborhood geometry validation and finalization |
| `12-pg-stat-statements.sql` | Performance instrumentation extension (also applied to existing volumes) |
| `zz-database-roles.sh` | Runtime ownership and reader permissions |

Fresh volumes execute these files in lexical order. The application runner
records each filename and checksum in `schema_migrations`, applies missing
files transactionally, and uses an advisory lock. When Docker has already
executed the complete init directory, the runner adopts the current schema
into the ledger instead of replaying its `CREATE` statements. Existing
volumes from the retired migration chain are supported when their live schema
matches this current state; retired ledger filenames are preserved.

The canonical SQL is the source of truth. To change the schema, update the
current definitions and regenerate/verify the full baseline. Operational
extensions that must be installed on an existing volume may be added as a
new, idempotent, lexically ordered file and applied by the same migrator. The
dedicated Compose migrator performs the required bootstrap-admin preflight for
extensions that PostgreSQL does not permit the migrator owner role to create;
the extension file is still tracked transactionally in `schema_migrations`. Do
not use that mechanism to override an earlier schema definition.

## OLTP and OLAP boundary

The scraper-owned tables in `public` are the system of record: current listing
state, search/run state, raw response evidence, and append-only state and price
events. `listing_daily` is the historical inventory projection.

Physical dashboard-grain tables live in `olap`. Ingestion never writes them
directly. Grafana reads stable views and functions in `reporting`, backed by the
published OLAP snapshot. Source views ending in `_source` define the canonical
transformations and support validation.

`reporting.refresh_dashboard_olap()` publishes a consistent generation of all
marts and records it in `olap.refresh_state`. The maintenance cycle rebuilds
pending daily history, refreshes current-market marts, runs operational
cleanup, and validates reporting contracts. Operational health panels read live
run and refresh-control state; analytical panels read published snapshots.

Monthly partitions cover event and daily-history tables. Maintenance creates
partitions across all available history and upcoming months, and records
validation results. Historical evidence, daily projections, OLAP marts, and
scrape runs have no retention period and are never deleted because of age.
Raw response bodies and maintenance-run logs keep their separate operational
cleanup policies. Evidence updates and deletes are rejected except through the
audited maintenance path.

## Geography

Neighborhood boundaries are stored as PostGIS `MultiPolygon` geometry in SRID
4326 with a GiST index. `public.neighborhood_of(lat, lon)` uses `ST_Covers`
for containment and a five-kilometre geography-distance fallback. Shared
boundary matches are deterministic by neighborhood priority and name.

Regenerate the geographic seed with `node geo/scripts/gen-sql.js` from the
repository root. Do not hand-edit generated polygon data.
