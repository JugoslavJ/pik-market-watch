# Lean database

`@pik-market-watch/db` owns the PostgreSQL schema and persistence. `src/client.js` provides connections and leases, `src/ingestion.js` writes listing/search state, `src/raw-responses.js` manages archives and retention, and `src/migrate.js` applies schema changes.

Run from the repository root after `npm ci`:

```sh
npm test --workspace @pik-market-watch/db
npm run test:integration
npm run benchmark:ingestion
npm run migrate --workspace @pik-market-watch/db
npm run maintenance --workspace @pik-market-watch/db
```

Integration tests and benchmarks use disposable databases. Migration and maintenance jobs require `DATABASE_URL` with the appropriate role. Settings live in `src/config.js`.

`init-lean/` supplies both first-boot initialization and later migrations. Listing data lives in `lean`; extensions and the migration ledger live in `public`. Create the external `POSTGRES_VOLUME_NAME` volume before startup (default `olx-price-ext_pgdata_pg18`). Volume names remain stable across checkout renames.

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

The migrator records checksums in `public.schema_migrations` and adopts already initialized schemas. Never edit applied SQL files; append new ordered migrations under `init-lean/`.

`remote-restore.sh` handles synchronized lean database restores. PostgreSQL
extension objects in `public` remain installed by the database bootstrap.
