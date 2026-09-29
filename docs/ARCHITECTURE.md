# Architecture and data model

The scraper stores OLX listing state and evidence in PostgreSQL's `lean`
schema. Grafana reads the same lean tables through a read-only role. The
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

The application does not maintain OLAP marts, reconstructed daily inventory,
listing scores, or historical attribute snapshots. Dashboard trend panels
derive their summaries from retained observed dates. A closure is an observed
listing exit, not a confirmed sale; its price is the last observed asking
price.

## Dashboards

Grafana provisions four dashboards from `grafana/dashboards-lean/`:

- **Home** summarizes current market and scraper health.
- **Overview** reports active inventory, asking prices, trends, maps, and
  listing attributes.
- **Exits** analyzes observed listing closures using lifecycle events.
- **Health** reports scrape outcomes, freshness, and data quality.

Dashboard SQL queries the lean tables directly. Grafana connects with the
read-only `olx_reporting` role. The `olx_app` role writes scraper data;
`olx_migrator` owns schema changes; and `olx_backup` is used by database
backups.

## Geography

`geo/banja-luka-mz-final.geojson` is the source for the generated
`db/init-lean/02-lean-neighborhoods.sql` seed. Regenerate it with
`node geo/scripts/gen-lean-sql.js`. The PostGIS polygons support point
containment and a nearest-boundary fallback within five kilometres. See
[the geography workflow](../geo/README.md) and [data provenance](../DATA.md).
