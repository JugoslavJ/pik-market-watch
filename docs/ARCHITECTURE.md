# Architecture and data model

The scraper stores OLX listing state and evidence in PostgreSQL's `lean`
schema. The React viewer and Superset read lean data through
the same read-only role. Superset metadata is isolated in its own database and
owner role in the same PostgreSQL cluster. The
database keeps current listing state, observed price history, closure/reopen
events, scrape runs, retained API responses, and page manifests.

## Runtime

Compose gates the scraper and maintenance job on the one-shot `migrator`.
That job applies the ordered `db/init-lean/` baseline and records checksums in
`public.schema_migrations`. The scraper's startup migration fallback uses the
same baseline for standalone runs. Search cycles use an advisory lease,
preserve membership after incomplete searches, and only close listings after
authoritative results.

The scraper enriches current listing rows from detail responses and records
source-reported price changes. Lean archive maintenance applies the configured
raw-response retention policy. `replay-response.js` reads retained responses
without writing listing or price data.

The `collector/` package owns API requests, mapping, normalization and collection
orchestration. `collector/src/api.js` fetches and decodes responses;
`payload-mapper.js` maps API fields to listing records, while `normalization.js`
applies price, currency, date and measurement policy.

The database package exposes `Db` and `applyMigrations` to the collector.
`db/src/client.js` manages connections and advisory leases. `db/src/ingestion.js`
owns listing writes, search runs and lifecycle transitions;
`db/src/raw-responses.js` owns API archives, page manifests and retention.
Migration and maintenance entry points load only `db/src/config.js`; collector
settings and saved searches are independent. Both packages use the environment
validators in `config/env.js`.

Unit and database integration tests live with their owning packages. Dashboard
contracts live in `superset/tests/`, viewer browser checks in
`dashboard-viewer/tests/`, and stack deployment/security contracts in
`tests/contracts/`. Repository tooling runs from the root npm workspace.

## Storage

| Table | Contents |
| --- | --- |
| `lean.listings` | Current listing attributes, current search membership, and present closure state |
| `lean.saved_searches` | Configured search identities and latest scrape summaries |
| `lean.scrape_runs` | Per-search run results and completeness state |
| `lean.price_history` | Source-reported asking prices by listing, date, and source |
| `lean.listing_lifecycle_events` | Append-only closure and reopen events with event-time snapshots |
| `lean.neighborhoods` | Banja Luka neighborhood boundaries used to classify map pins |
| `lean.raw_api_responses` | Retained search/detail payloads and request diagnostics |
| `lean.scrape_run_pages` | Page-level response, parse, and completeness evidence |

Dashboard trends derive their summaries from observed prices, lifecycle
events, and scrape runs. A closure is an observed listing exit, not a confirmed
sale; its price is the last observed asking price.

## Dashboards

The React viewer serves four dashboards at host port 3000:

- **Home** summarizes current market and scraper health.
- **Overview** reports active inventory, asking prices, trends, maps and listing attributes.
- **Exits** analyzes observed listing closures using lifecycle events.
- **Health** reports scrape outcomes, freshness and data quality.

Superset supplies login, permissions, dataset definitions and the viewer API. It listens on container port 8088, published only at `127.0.0.1:3000`. The root URL and Superset welcome page redirect to Market Overview. Viewer navigation exposes only these four dashboards.

Each fresh viewer request executes one reporting data statement with shared facts and aggregates. Charts keep their previous values during filter updates. Market/exit snapshots expire after ten minutes; operational Home/Health results are uncached. Tables provide links and CSV; MapLibre uses CARTO vector basemaps.

Definitions in `superset/dashboards/` supply the trusted SQL/panel contract used by the compiler and parity comparisons. The application migrator, writer, reporting and backup roles retain their separate responsibilities.

See [viewer details](../dashboard-viewer/README.md), [performance measurements](../superset/PERFORMANCE.md) and [instance deployment](DEPLOYMENT.md).

## Geography

`geo/banja-luka-mz-final.geojson` is the source for the generated
`db/init-lean/02-lean-neighborhoods.sql` seed. Regenerate it with
`node geo/scripts/gen-lean-sql.js`. The PostGIS polygons support point
containment and a nearest-boundary fallback within five kilometres. See
[the geography workflow](../geo/README.md) and [data provenance](../DATA.md).
