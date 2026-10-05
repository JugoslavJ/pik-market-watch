# Lean database

This directory owns the PostgreSQL schema and Node persistence package,
`@pik-market-watch/db`. `src/client.js` supplies the connection pool and leases;
`src/ingestion.js` owns listing/search writes, and `src/raw-responses.js` owns
transport archives, page manifests and retention. `src/migrate.js` manages the
schema baseline. Database code depends on `pg` and shared environment validators,
and has no dependency on the collector or dashboard packages.

Install workspace dependencies with `npm ci` from the repository root. Run
database unit tests with `npm test --workspace @pik-market-watch/db`, database
integration tests with `npm run test:integration`, and the optional disposable
database benchmark with `npm run benchmark:ingestion`. Bare Node jobs use
`npm run migrate --workspace @pik-market-watch/db` and
`npm run maintenance --workspace @pik-market-watch/db`; provide `DATABASE_URL`
and the appropriate database role. Database settings are in `src/config.js`
and do not load saved searches or API pacing settings.

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
