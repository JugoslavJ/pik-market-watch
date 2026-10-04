> Historical migration plan. Current deployment retires Grafana and serves only the React viewer on port 3000; see [the current runbook](SUPERSET_CUTOVER.md).

# Grafana to Superset migration plan

## Goal and current state

Make Superset the only dashboard service on the OCI instance, while preserving
the market analysis, scraper health visibility, alerts, public access controls,
backups, and deployment behavior currently supplied by Grafana. Keep Grafana
running until the replacement passes the cutover gates below.

Superset runs beside Grafana through the production Compose profile. The seed
creates four source-dashboard counterparts with 71 native charts, alongside the
market explorer and focused companion dashboards. Source counterparts preserve
line, column, bar, scatter, KPI, table, and vector map views. The provisioned Grafana estate has 71 non-row panels across four
dashboards, plus two alert rules:

| Grafana dashboard | Panels | Migration scope |
| --- | ---: | --- |
| Home | 11 | Market and pipeline summary, inventory flow |
| Market Overview | 25 | Prices, inventory, segments, listing tables, map, price drops |
| Exits & Price Endings | 14 | Observed closures, liquidity, exit map and detail |
| Scraper Health | 21 | Run history, freshness, errors, coverage and data quality |

The seed provisions one native counterpart for every source panel. Reused KPI
queries share a dataset and cache while retaining their individual cards. A table
is a counterpart only for a source table; chart and map views retain their visual
form. Source: `grafana/dashboards-lean/*.json` and
`grafana/provisioning-lean/alerting/olx-alerts.yml`.

## 1. Inventory and semantic contract

- Record each Grafana panel's SQL, variables, time range, unit, link behavior,
  and expected result in a migration matrix. Mark duplicates that can share a
  Superset metric or dataset. Include both alert predicates.
- Preserve the existing meanings: a closed ad is an **observed exit**, not a
  confirmed sale; its final price is the last recorded asking price. Preserve
  BAM-only monetary measures and distinguish sale prices from monthly rents.
- Define reusable, version-controlled datasets or PostgreSQL views for active
  listings, price history, lifecycle events, saved searches, and scrape runs.
  Rewrite Grafana variables and `$__` macros as Superset filters and explicit
  SQL; do not copy panel SQL into Superset unchanged.
- Set a cache policy per dataset. Market data may use the current 10-minute
  cache; freshness and alert checks must query recent data without that delay.

**Gate:** every Grafana panel and alert has an owner, target dataset/chart or
documented consolidation, and a comparison query against the same database
snapshot. No metric disappears silently.

## 2. Production Superset foundation

- Promote the prototype from the opt-in Compose overlay into the production
  deploy path while Grafana remains live. The current deploy script pulls,
  restarts, and checks Grafana, and `--remove-orphans` can remove services that
  are not included in its Compose invocation. Update that path before the
  side-by-side production run.
- Prefer a **separate `superset_meta` database and dedicated owner inside the
  existing PostgreSQL 18 cluster** instead of a second PostgreSQL container.
  This retains metadata isolation at the database and role level and saves the
  extra server process. The home-to-instance restore replaces schemas inside
  the `olx` database; verify that it leaves `superset_meta` untouched. Include
  an idempotent role/database creation step for existing PG volumes.
- Keep the `olx_reporting` role read-only for analytical data. Limit Superset's
  metadata role to `superset_meta`; review connection counts against the
  existing PostgreSQL `max_connections=40` limit.
- Version Superset datasets, metrics, charts, dashboard layouts, filters, and
  roles through idempotent API provisioning or exported assets. Extend the
  current seed rather than relying on manual edits. Add CI validation and a
  production deploy gate for Superset health and representative chart queries.
- Configure the Cloudflare Tunnel path for Superset: loopback-only port,
  trusted forwarded HTTPS headers, secure session cookies, stable secret key,
  authentication, and least-privilege viewer/editor roles. Keep dashboards
  private during parallel validation; publish only the approved dashboards.

**Gate:** a clean deployment and a restore/redeploy both recreate a healthy,
private Superset instance with the same dashboard definitions. Grafana remains
the public destination at this point.

## 3. Dashboard migration

Build and validate in this order:

1. **Home and Market Overview:** reuse the prototype's active listings dataset,
   then add price trends, price drops, history, segment summaries, ranking
   tables, and listing links. Split the 25-panel overview into focused sections
   or tabs so one click does not refresh an oversized page.
2. **Exits:** use lifecycle events and their event-time snapshots for closure
   charts. Keep the observed-exit wording and the original time-window logic.
3. **Scraper Health:** reproduce run counts, per-search freshness, incomplete
   searches, detail backlog, and error tables. Use shorter or disabled query
   caching for operational status.
4. **Maps and navigation:** provision both active and exit pin maps with CARTO
   vector basemaps and validate them on the deployed Superset version. Verify coordinate bounds,
   point count, tooltip contents, and the click-through to the OLX ad. If a
   map plugin cannot provide the same link action, pair it with a filtered
   clickable listing table before accepting it.
5. **Interactions:** apply shared native filters for category, deal, rooms,
   neighborhood, and area, plus any relevant sale/rent and time controls.
   Preserve click-to-filter between charts on each dashboard. Verify what
   happens when navigating between dashboards; carry filter state through
   explicit links if cross-page persistence is needed.

**Gate:** compare every migrated measure and table with Grafana using identical
filters and data snapshots. Check desktop and phone layouts, links, permissions,
empty states, and maps. Test common clicks on the OCI host; proposed performance
budget is p95 at most 1 second for a cached filter change and 2 seconds for a
fresh change, with no regression against the Grafana baseline. Adjust chart
count, SQL, indexes, and cache policy before cutover if the budget is missed.

## 4. Alerts, backup, and recovery

- Preserve the two current rules: no successful scrape in 26 hours, and a stale
  or failing saved search. For the resource-conscious deployment, use a small
  scheduled SQL checker for evaluation and optional notification, and show
  current status and supporting data on the Superset Health dashboard. Test
  firing and recovery with controlled fixtures. If Superset's own Alerts &
  Reports UI or scheduled emails are required, budget for Celery beat/worker,
  a broker such as Redis, SMTP, and worker browser support instead.
- Extend `db/backup.sh` and the backup healthcheck to dump and verify the
  separate `superset_meta` database alongside `olx`, granting the backup role
  only the access it needs for that dump. Preserve the secret key
  securely because it protects stored connections. Rehearse restoration of
  both databases and Superset login/dashboard access in a disposable stack.
- Update `db/remote-restore.sh` so a successful `olx` schema replacement
  reconnects/refreshes Superset instead of Grafana and checks a real chart.
  Confirm the metadata database and its backups are never overwritten by the
  home-to-instance `olx` sync.
- Update the operations guide, CI/CD, smoke checks, benchmark scripts, and
  dashboard links to use Superset. Keep the dashboard definitions reproducible
  from the repository.

**Gate:** both health conditions evaluate and notify as configured; a fresh
verified metadata backup exists; an end-to-end recovery rehearsal succeeds;
and automated deploy and sync paths leave Superset healthy.

## 5. Cutover and Grafana retirement

1. Run both systems against the same data for at least one complete scrape and
   sync cycle, including a real closure event and price update. Compare key
   totals and alert states daily during the parallel run.
2. Change the Cloudflare Tunnel public hostname to Superset after user access,
   HTTPS cookie behavior, links, and performance pass. Keep Grafana available
   only on loopback as the immediate rollback path.
3. After a successful soak period and verified Superset metadata backup, stop
   Grafana and confirm the public route, deployments, syncs, and backup jobs
   still work. If a gate fails, repoint the tunnel to Grafana and investigate
   without restoring the application database.
4. Remove the Grafana service, its restart/health dependencies, provisioning,
   benchmark scripts, Grafana-only environment variables, and backup-volume
   mount from active deployment. Retain a final Grafana archive/volume for the
   agreed rollback retention period, then remove it and its obsolete images.
   Keep `olx_reporting`: Superset still uses that role.

**Final gate:** production deploy, home-to-instance sync, backup and restore,
alerts, and all dashboard workflows operate with Grafana stopped. Only then
delete Grafana-specific code and stored state.

## Implemented transition support

Shared API/provisioning/map helpers, explicit viewer publication, mode-aware deploy
and restore, verified one-shot backups, and readiness checks are implemented.
[The cutover runbook](SUPERSET_CUTOVER.md) defines the remaining production
acceptance and public routing steps; local tests do not mark those gates complete.

## Resource expectation

On the local prototype, an idle sample showed Grafana around **148 MiB**,
Superset around **218 MiB**, and its separate metadata PostgreSQL around
**169 MiB**. Stopping Grafana frees its process resources, but simply swapping
it for the current two-container Superset setup does not lower total memory.
Using the existing PostgreSQL cluster for a separate metadata database avoids
most of the extra database-container cost. Measure memory, CPU throttling,
database connections, and dashboard response times on OCI during the parallel
run before setting final service limits.

Superset references: [dashboard access and filter bar](https://superset.apache.org/docs/6.0.0/using-superset/creating-your-first-dashboard/),
[cache configuration](https://superset.apache.org/docs/6.0.0/configuration/cache/),
[reverse proxy](https://superset.apache.org/docs/6.0.0/configuration/configuring-superset/),
and [alerts and reports](https://superset.apache.org/docs/6.0.0/configuration/alerts-reports/).
