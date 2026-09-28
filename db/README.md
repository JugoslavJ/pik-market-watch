# Database schema

The live deployment uses `lean` for listing state, runs, price history,
closure history, raw-response evidence, and Grafana dashboards. Phase 6
removed the old OLAP/reporting schemas and legacy application relations from
`public`; PostgreSQL and PostGIS extension objects remain there.

`init-lean/` is the current first-boot baseline and Compose default. The old
`init/` directory is retained as a historical source schema for restores and
migration tests; do not select it for a new database.

The remaining `init/` object inventory and OLAP notes below document that
historical public baseline. They are not part of the current runtime contract.

`init/` is the canonical current schema. The SQL is split by dependency and
responsibility for readability.

| File                         | Responsibility                                                           |
| ---------------------------- | ------------------------------------------------------------------------ |
| `00-core-schemas.sql`        | Required extensions and application schemas                              |
| `01-tables.sql`              | OLTP tables, OLAP marts, control tables, and sequences                   |
| `01-storage-json.sql`        | Shared immutable JSON fragments for retained raw response bodies        |
| `02-constraints.sql`         | Keys, foreign keys, and table constraints                                |
| `03-functions.sql`           | Ingestion, analytics, geography, partition routing, and trigger helpers  |
| `03-z-state-attribute-storage.sql` | Shared listing-state characteristics and logical compatibility view |
| `03-zz-storage-json.sql`     | JSON fragment interning and exact reconstruction                         |
| `04-source-views.sql`        | Canonical OLTP-to-OLAP source transformations                            |
| `05-reporting-functions.sql` | Dashboard refresh, filtering, comparison, and validation functions       |
| `06-reporting-views.sql`     | Stable reporting views used by Grafana                                   |
| `07-indexes.sql`             | Operational, spatial, and dashboard indexes                              |
| `08-triggers.sql`            | Evidence normalization and analytics invalidation                        |
| `09-neighborhood-data.sql`   | Generated neighborhood seed data                                         |
| `10-seed-and-access.sql`     | Initial control rows and reporting grants                                |
| `11-postgis.sql`             | Derived neighborhood geometry validation and finalization                |
| `12-pg-stat-statements.sql`  | Performance instrumentation extension (also applied to existing volumes) |
| `13-raw-json-storage.sql`    | Lossless raw-body factoring and logical compatibility view               |
| `zz-database-roles.sh`       | Runtime ownership and reader permissions                                 |

Fresh volumes execute these files in lexical order. The application runner
records each filename and checksum in `schema_migrations`, applies missing
files transactionally, and uses an advisory lock. When Docker has already
executed the complete init directory, the runner adopts the current schema
into the ledger instead of replaying its `CREATE` statements. Applied files
are checksum protected: a mismatch stops deployment. Volumes on the previous
canonical baseline apply the ordered storage-normalization files in one
transaction; these backfill existing state characteristics and raw JSON while
preserving their logical read interfaces. Other baseline drift requires a
verified current-schema restore. Unrelated migration-ledger entries are
preserved.

The canonical SQL is the source of truth. Keep already-applied files and their
checksums stable; put ordered data conversions and compatibility changes in
new canonical files so existing volumes can apply them transactionally. The
dedicated Compose migrator performs the required bootstrap-admin preflight for
extensions that PostgreSQL does not permit the migrator owner role to create;
each new file is tracked transactionally in `schema_migrations`.

## OLTP and OLAP boundary

The legacy scraper-owned tables in `public` are retained during rollout as a
source and rollback copy. The lean scraper writes current listing state,
search/run state, price observations, and closure history to `lean`. Raw
response evidence still lands in the legacy archive and must be migrated with
its read and maintenance functions before the public listing and run tables
can be retired. `listing_daily` is legacy historical inventory projection.

`listings.price` keeps the last valid amount observed for the current sale or
rent segment. `price_text` keeps the latest source display, including "Na upit".
The latest `listing_price_events.price_state` records whether the ad is
currently priced; a retained amount must not be treated as a fresh asking
price. Closing snapshots retain that last valid amount and its sale rate.

Physical dashboard-grain tables live in `olap`. Ingestion never writes them
directly. Grafana reads stable views and functions in `reporting`, backed by the
published OLAP snapshot. Source views ending in `_source` define the canonical
transformations and support validation.

`reporting.refresh_dashboard_olap()` publishes a consistent generation of all
marts and records it in `olap.refresh_state`. The maintenance cycle rebuilds
pending daily history, runs operational cleanup, and analyzes partitions.
The scraper publishes the current market and validates reporting contracts.
Operational health panels read live
run and refresh-control state; analytical panels read published snapshots.

Monthly partitions cover event and daily-history tables. Maintenance creates
partitions across all available history and upcoming months, and records
validation results. Historical evidence, daily projections, OLAP marts, and
scrape runs have no retention period and are never deleted because of age.
Raw response bodies and maintenance-run logs keep their separate operational
cleanup policies. Retained response JSON is stored as shared immutable
fragments for objects and arrays of at least 1 KiB. New response bodies land in
`raw_api_response_pending` and operational cleanup factors them into shared
immutable documents in bounded batches, moving the metadata row into
`raw_api_response_records`. The `raw_api_responses` view combines pending bodies
with reconstructed compacted bodies and retains the existing application
read/write contract. Cleanup removes expired roots set-wise, compacts retained
bodies, then deletes dictionary fragments only when no retained response
references them. Evidence updates and deletes are rejected except through the
audited maintenance path.

Repeated `characteristics` objects in historical listing states are stored
once in `listing_state_characteristic_documents`. The physical
`listing_state_version_records` table stores the document reference and the
remaining state attributes; `listing_state_versions` reconstructs the original
logical JSONB value for source views and application readers.

## Geography

Neighborhood boundaries are stored as PostGIS `MultiPolygon` geometry in SRID
4326 with a GiST index. `public.neighborhood_of(lat, lon)` uses `ST_Covers`
for containment and a five-kilometre geography-distance fallback. Shared
boundary matches are deterministic by neighborhood priority and name.

Regenerate the geographic seed with `node geo/scripts/gen-sql.js` from the
repository root. Do not hand-edit generated polygon data.
