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
| `01-lean-schema.sql` | Complete schema, including daily prices and lifecycle events, raw archives, page manifests, and dashboard indexes |
| `02-lean-neighborhoods.sql` | Generated neighborhood boundaries |
| `zz-database-roles.sh` | Runtime, migration, reporting, Superset metadata and backup roles |

The migrator records checksums in `public.schema_migrations` and adopts already initialized schemas. Outside deliberate baseline consolidations, keep applied SQL files immutable and append new ordered migrations under `init-lean/`.

The baseline consolidates the former `03`–`05` migrations into the original table definitions. Fresh installs create columns with their final types, defaults, and constraints directly, without conversion or cleanup DDL. Future baseline consolidations should follow the same pattern.

Existing databases with the former files recorded need a deliberate migration-ledger rebaseline after verifying that their installed schema matches the consolidated baseline. The migrator continues to reject changed checksums; this consolidation does not automatically upgrade an older schema or rewrite its ledger.

`remote-restore.sh` handles synchronized lean database restores. PostgreSQL
extension objects in `public` remain installed by the database bootstrap.
