# Database

`@pik-market-watch/db` owns the PostgreSQL schema and persistence. `src/client.js` provides connections and leases, `src/ingestion.js` writes listing/search state, `src/raw-responses.js` manages archives and retention, and `src/migrate.js` applies schema changes.

Run from the repository root after `npm ci`:

```sh
npm test --workspace @pik-market-watch/db
npm run test:integration
npm run migrate --workspace @pik-market-watch/db
npm run maintenance --workspace @pik-market-watch/db
```

Integration tests use disposable databases. Migration and maintenance jobs require `DATABASE_URL` with the appropriate role. Settings live in `src/config.js`.

`init-lean/` supplies both first-boot initialization and later migrations. Listing data lives in `lean`; extensions and the migration ledger live in `public`. Create the external `POSTGRES_VOLUME_NAME` volume before startup (default `olx-price-ext_pgdata_pg18`, kept from the project's earlier name so existing data stays attached).

The numbered SQL files run in lexical order:

| File                           | Responsibility                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `00-extensions.sql`            | Required PostGIS and statistics extensions                                                                        |
| `01-lean-schema.sql`           | Complete schema, including daily prices and lifecycle events, raw archives, page manifests, and dashboard indexes |
| `02-lean-neighborhoods.sql`    | Generated neighborhood boundaries                                                                                 |
| `03-price-evidence.sql`        | Allows explicit `unknown` deal and currency values                                                                |
| `04-drop-unused-indexes.sql`   | Drops coordinate, search-key and archive-article indexes that no query uses                                       |
| `05-declared-deal-type.sql`    | Reclassifies deals by the ad's declared kind                                                                      |
| `06-olx-categories.sql`        | Adds the `daily_rent` deal, drops the saved-search category label and retires unconfigured searches               |
| `07-neighborhood-outlines.sql` | Stores each boundary as GeoJSON for area maps, which the reporting role reads without PostGIS                     |
| `08-detail-area-and-rooms.sql` | Fills area and rooms from fetched details that name them differently                                              |
| `zz-database-roles.sh`         | Runtime, migration, reporting, Superset metadata and backup roles                                                 |

The migrator records checksums in `public.schema_migrations` and rejects changed files. When Docker has already initialized a database from the `00`–`02` baseline, the migrator records those files without replaying them; later files run normally. Keep applied SQL files immutable and append new ordered migrations under `init-lean/`.

`remote-restore.sh` handles synchronized lean database restores. PostgreSQL
extension objects in `public` remain installed by the database bootstrap.
