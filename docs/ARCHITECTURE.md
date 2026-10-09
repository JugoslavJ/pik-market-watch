# Architecture and data model

The collector writes listing state and API evidence to PostgreSQL's `lean` schema. The viewer and Superset query it as `olx_reporting`. Superset metadata lives in the separately owned `superset_meta` database in the same cluster.

## Runtime

Compose runs the one-shot migrator before collection or maintenance. Standalone collection uses the same migration runner at startup. An advisory lease prevents overlapping cycles. Incomplete searches preserve listing membership; only authoritative results can close listings.

Detail requests enrich listings and record source price changes. Archive maintenance enforces response retention; `replay-response.js` reads retained payloads without changing listing data.

The [collector](../collector/README.md) owns requests, normalization and scheduling; the [database package](../db/README.md) owns storage and schema jobs. Both use `db/src/env.js` for environment validation. Database jobs load settings independently of searches.

Tests live with their packages. Cross-component deployment and security checks live in `tests/contracts/`.

## Storage

| Table | Contents |
| --- | --- |
| `lean.listings` | Current listing attributes, current search membership, and present closure state |
| `lean.saved_searches` | Configured search identities and latest scrape summaries |
| `lean.scrape_runs` | Per-search run results and completeness state |
| `lean.price_history` | Source-reported asking prices by listing, date, and source |
| `lean.listing_lifecycle_events` | Append-only closure and reopen events with event-time snapshots |
| `lean.neighborhoods` | Banja Luka neighborhood boundaries used to classify map pins |
| `lean.raw_api_responses` | Latest detail payload per listing, malformed search pages and request diagnostics |
| `lean.scrape_run_pages` | Page-level response, parse, and completeness evidence |

A listing's property type is its OLX subcategory under Nekretnine
(apartments, houses, land, commercial space, garages and so on), so one
search over all real estate feeds every board. Market boards default to
apartments. Daily rentals ("Stan na dan") carry their own `daily_rent` deal:
OLX posts them as sales with nightly prices, and only the Daily Rent board
shows them. Holiday cottages asking under 300 KM are let by the night too.

Advertisers also type monthly rents and prices per m² into OLX's sale field.
A "sale" under the sale minimum is read by property type instead of dropped:
land up to 500 KM is a price per m² (the total is that times the plot),
commercial space, garages, rooms and warehouses are rentals, and apartments
and houses are prices per m² from 1,000 KM (300 KM when the ad says it is a
sale) and rentals below. An ad that declares itself a sale stays one.

Dashboard trends derive their summaries from observed prices, lifecycle
events, and scrape runs. A closure is an observed listing exit, not a confirmed
sale; its price is the last observed asking price.

## Dashboards

The React viewer serves eight dashboards at host port 3000:

- **Home** summarizes the market and data freshness; every role lands here.
- **Buy** helps buyers: price check against comparables, negotiation room, neighborhoods and listings priced below their area.
- **Rent** helps tenants: rent check, rent by neighborhood and rooms, what amenities add, and how fast rentals go.
- **Daily Rent** serves short-stay hosts: nightly prices by neighborhood and rooms, price bands, supply flow and new listings.
- **Market Intelligence** serves agents and agencies: months of inventory, supply and demand by neighborhood, pricing accuracy, the agency/private split, private-seller leads, yields and comparative market analysis.
- **Overview** reports active inventory, asking prices, trends, maps and listing attributes.
- **Exits** analyzes observed listing closures using lifecycle events.
- **Health** reports scrape outcomes, freshness and data quality.

Superset supplies login, user roles and the viewer API; it holds no dashboards, charts or datasets. Container port 8088 is published at `127.0.0.1:3000`; the root and welcome page open Home. Each audience has its own role ([accounts and access](../superset/README.md#accounts-and-access)); the viewer switches between English and Serbian (Latin or Cyrillic) and prints any board as a report.

Each fresh viewer request executes one reporting data statement with shared facts and aggregates. Charts keep their previous values during filter updates. Market/exit snapshots expire after ten minutes; operational Home/Health results are uncached. Tables provide links and CSV; MapLibre uses CARTO vector basemaps.

[Dashboard definitions](../superset/README.md#terms) in `superset/dashboards/` supply the panel SQL, which the viewer runs as the read-only reporting role. Migration, writer, reporting and backup roles have separate privileges.

See [viewer details](../dashboard-viewer/README.md) and [deployment](DEPLOYMENT.md).

## Geography

`db/init-lean/02-lean-neighborhoods.sql` seeds approximate Banja Luka
neighborhood boundaries. The PostGIS polygons support point containment and a
nearest-boundary fallback within five kilometres. The seed is an applied
baseline; ship boundary changes as a new ordered migration. See
[data provenance](../DATA.md).
