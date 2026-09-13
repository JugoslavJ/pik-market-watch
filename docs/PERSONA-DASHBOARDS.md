# Private persona dashboards

The buyer, renter, and agent dashboards are private Grafana dashboards backed by
the `reporting` schema. They describe tracked OLX asking evidence and link back
to the source ad; they are not appraisals, transaction records, CRM views, or
public dashboards.

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
private renter and agent rental views and does not change existing public views.
The agent switches sale and rent populations and units together; sale and rent
are never pooled into a headline metric or yield.

## Artifacts and deployment

The three dashboard JSON files are checked-in Grafana provisioning artifacts:
`grafana/dashboards/olx-buyer.json`, `grafana/dashboards/olx-renter.json`, and
`grafana/dashboards/olx-agent.json`. Edit the relevant artifact directly when a
persona contract changes. CI validates their structure and query contracts with
the `npm test` suite from `scraper`.

The private reporting objects are supplied by additive migrations
[`16-listing-comparison.sql`](../db/init/16-listing-comparison.sql) and
[`17-persona-history.sql`](../db/init/17-persona-history.sql). On a
dashboard-only host, apply them with:

```bash
docker compose --profile migrate run --build --rm migrator
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose restart grafana
```

The normal deployment path runs the role helper after migrations and restarts
Grafana as part of deployment. The explicit helper invocation is required when
applying migrations manually because private views and functions need the
reader grants. Existing public dashboards retain their fixed filters and
allowlisted `dashboard_public` surface.

## Acceptance mapping and current limits

| Contract area | Delivered component | Validation boundary |
|---|---|---|
| Shared score, currency, comparable cohort | Migration 16 and private reporting views | SQL and integration checks; rendered Grafana values still require deployment verification. |
| Historical prices, units, lifecycle facts | Migration 17 and `reporting.daily_listing_facts` / lifecycle views | Historical rows preserve evidence quality; no inferred pre-currency backfill. |
| Persona filters and panels | Checked-in dashboard JSON artifacts | CI checks the JSON structure and query contracts; rendered Grafana values still require deployment verification. |
| Private access | `zz-database-roles.sh` reader grants | Re-run the helper after manual migration, then restart Grafana. |
| Public compatibility | Existing `dashboard_public` views and dashboards | Monthly rental rule and private history do not alter public views. |

The supplied specification filenames are the source of truth; no filename
normalization is implied. The remaining product limitations are explicit in
the persona specifications, including sparse attributes, listing-level rather
than property-level identity, and lack of transaction outcomes.
