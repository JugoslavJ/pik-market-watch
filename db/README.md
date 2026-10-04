# Lean database

`init-lean/` is the sole first-boot schema baseline. Compose mounts it for both
PostgreSQL initialization and the checksum-managed migrator. The scraper writes
to the `lean` schema; `public` contains PostgreSQL extension objects and the
migration ledger. Compose uses an external PostgreSQL volume selected by
`POSTGRES_VOLUME_NAME` (default `olx-price-ext_pgdata_pg18`). Create that volume
with `docker volume create olx-price-ext_pgdata_pg18` before first startup.
The deployed database and Superset home volume names remain stable across
checkout renames.

The numbered SQL files run in lexical order:

| File | Responsibility |
| --- | --- |
| `00-extensions.sql` | Required PostGIS and statistics extensions |
| `01-lean-schema.sql` | Current listings, searches, runs, prices, and lifecycle events |
| `02-lean-neighborhoods.sql` | Generated neighborhood boundaries |
| `03-raw-archive.sql` | Retained raw API responses and page manifests |
| `04-date-based-price-history.sql` | Canonical local-date representation |
| `05-dashboard-query-indexes.sql` | Dashboard range, latest-run, and API price-history indexes |
| `zz-database-roles.sh` | Runtime, migration, reporting, Superset metadata and backup roles |

The migrator records each SQL file and checksum in `public.schema_migrations`,
adopts an already initialized lean schema, and rejects changes to applied
files. Add future schema changes as new ordered SQL files under `init-lean/`;
never edit an applied file. The same canonical directory bootstraps fresh
databases and applies appended changes to existing lean deployments.

`remote-restore.sh` handles synchronized lean database restores. PostgreSQL
extension objects in `public` remain installed by the database bootstrap.
