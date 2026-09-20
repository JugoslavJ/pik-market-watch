# Private persona dashboards

The buyer, renter, and agent dashboards are private Grafana dashboards backed by
the `reporting` schema. They describe tracked OLX asking evidence and link back
to the source ad; they are not appraisals, transaction records, CRM views, or
externally shared dashboards.

| Persona | UID | Deal and unit basis | Main decision |
|---|---|---|---|
| Buyer | `olx-buyer` | Sale; KM and KM/m² | Find homes within a budget and compare local asking rates. |
| Renter | `olx-renter` | Rent; KM/month and KM/m²/month | Compare recurring rents, space, furnishing, and reductions. |
| Agent | `olx-agent` | Sale or rent; units switch with deal | Review competition, comparable evidence, pricing position, and observed lifecycle signals. |

All three use the shared version 1 comparison contract in
[LISTING-COMPARISON-CONTRACT.md](LISTING-COMPARISON-CONTRACT.md). Current
inventory is independent of historical windows: current listings use the
existing 14-day active rule, while history controls daily panels and event
review (30 days by default, with 90 days available where specified). Historical
currency evidence that predates recorded currency is unavailable by design;
those samples remain null or unscored and are not backfilled by inference.

Rental prices are monthly under the confirmed dataset rule. This applies to the
private renter and agent rental views.
The agent switches sale and rent populations and units together; sale and rent
are never pooled into a headline metric or yield.

## Artifacts and deployment

The three dashboard JSON files are checked-in Grafana provisioning artifacts:
`grafana/dashboards/olx-buyer.json`, `grafana/dashboards/olx-renter.json`, and
`grafana/dashboards/olx-agent.json`. Edit the relevant artifact directly when a
persona contract changes. CI validates their structure and query contracts with
the `npm test` suite from `scraper`.

The private reporting objects are supplied by the reporting SQL files and are
applied by the migrator. On a dashboard-only host, run:

```bash
docker compose --profile migrate run --build --rm migrator
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose restart grafana
```

The normal deployment path runs the role helper after migrations and restarts
Grafana as part of deployment. The explicit helper invocation is required when
applying migrations manually because private views and functions need the
reader grants. No externally shared dashboards are provisioned.

## Acceptance mapping and current limits

| Contract area | Delivered component | Validation boundary |
|---|---|---|
| Shared score, currency, comparable cohort | `reporting.current_listing_scores` and comparison functions | SQL and integration checks; rendered Grafana values still require deployment verification. |
| Historical prices, units, lifecycle facts | `reporting.daily_listing_facts` and lifecycle views | Historical rows preserve evidence quality; no inferred pre-currency backfill. |
| Persona filters and panels | Checked-in dashboard JSON artifacts | CI checks the JSON structure and query contracts; rendered Grafana values still require deployment verification. |
| Private access | `zz-database-roles.sh` reader grants | Re-run the helper after manual migration, then restart Grafana. |

The remaining product limitations are explicit in
the persona specifications, including sparse attributes, listing-level rather
than property-level identity, and lack of transaction outcomes.

## Desktop and mobile layout

The provisioned dashboards use one responsive-safe classic grid because Grafana
schema version 41 does not store separate desktop and mobile layouts. Summary
cards are at least eight of 24 grid columns wide (three cards per desktop row),
while maps, charts, and horizontally scrollable tables use the full row. This
keeps values and tap targets legible on phones and gives dense evidence panels
enough room on desktop. All private dashboards expose the same top navigation.

On a phone, use Grafana's dashboard search/filter controls first, then collapse
the variable picker to maximize the canvas. Tables intentionally keep compact
rows and horizontal scrolling rather than hiding evidence columns. Rotate to
landscape for detailed comparable and listing tables when practical.
