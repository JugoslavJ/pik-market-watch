# Superset dashboard service

Apache Superset 6.0.0 provides authentication, administration and reporting for the [React viewer](../dashboard-viewer/README.md) at `http://127.0.0.1:3000/` (container port 8088). Production uses [Cloudflare Tunnel](../docs/DEPLOYMENT.md).

## Terms

- **Dashboard definition**: one JSON file per dashboard in `dashboards/` (`olx-home`, `olx-overview`, `olx-exits`, `olx-health`). It holds the panels, filter variables, time windows, units and layout, and is the single source for both the viewer and the native dashboards.
- **Panel**: one stat, chart, table or map in a definition. A panel either has its own SQL or reuses another panel's query (`panelId`) and shows one of its fields.
- **Definition SQL**: a panel's query. It can use `${name:sqlstring}` filter placeholders and the `$__timeFilter(column)`, `$__timeFrom()` and `$__timeTo()` time macros, which both compilers expand.
- **Viewer**: the React app at `/olx/dashboard/<uid>/`. `viewer_queries.py` compiles each dashboard into one batched, parameterized statement.
- **Native dashboards**: ordinary Superset dashboards (slug `<uid>-superset`) that `parity.py` compiles from the same definitions. The viewer uses them for permissions and dataset checks.
- **Companion dashboards**: six extra native dashboards that `seed.py` creates for exploring the data in Superset. They are not in the viewer navigation.
- **Managed dashboards and datasets**: the ten dashboards and their datasets owned by the seed and access jobs. The viewer refuses to run (HTTP 409) when a managed dataset no longer matches the repository.
- **Parity**: the guarantee that native charts and the viewer return the same results as the definition SQL. `validate_parity.py` and `validate_viewer.py` check it against a live database.

## Accounts and publication

Start the stack as described in the [README](../README.md#start-locally), then sign in as `admin`. Public signup is disabled. The seed creates new native
dashboards as drafts and preserves existing publication and role assignments.
The production deployment publishes managed dashboards after readiness checks.
For a local authenticated viewer account, publish explicitly with
`docker compose run --rm superset-access --publish` and assign `OLX Viewer` to
the account. Publication does not grant anonymous access.

For a restricted account, assign **only `OLX Guest`** through `/users/list/`.
The access job creates this role with one `can_read on OLXDashboard` permission
and assigns it only to Home, Market Overview and Exits. It works through the
custom viewer, without dataset grants, native Superset dashboard/chart/dataset access, Health,
editing or SQL Lab. Other assigned roles can expand a user's access.
Rebuild/restart Superset after updating viewer code, then rerun `superset-access`
to apply the role. Provisioning removes any extra guest permissions and
dashboard assignments; it does not change existing user roles.

To prepare only the guest role and publish only its three dashboards:

```sh
docker compose --profile superset --profile superset-ops run --rm --no-deps superset-access --guest-only --publish
```

## Definitions and datasets

The four JSON files in `dashboards/` define 71 panels, scoped filter variables,
SQL, time windows, units and layouts. `viewer_queries.py` binds viewer selections
as SQL parameters and batches shared facts into one dashboard data statement.
`parity.py` compiles the same definitions into native Superset charts. With the
six companion dashboards, the jobs manage ten native dashboards. Viewer navigation
exposes Home, Overview, Exits and Health.

Dataset SQL lives in `datasets/` and `active-listings.sql`:

| Dataset group | Behavior |
| --- | --- |
| `active_listings`, `active_listing_categories` | Open listings and exact saved-search category membership without duplicating inventory counts |
| `best_value_sales`, `price_drops`, `price_history` | BAM sale rankings, recorded asking-price reductions and source price history; rent remains separate |
| `daily_market_summary`, `home_summary`, `daily_inventory_flow` | Market summaries and Sarajevo-day inventory movements |
| `lifecycle_events`, `recent_exits_30d`, `recent_exits_90d`, `recent_exit_points` | Observed closures with event-time price snapshots, including repeat exits after reopening |
| `saved_searches`, `scrape_runs`, `scrape_pages`, `scrape_run_summary`, `alert_status` | Operational completeness, freshness and alert facts |
| `listing_quality`, `listing_quality_summary` | Listing coverage and detail-backlog facts |

A closure is an observed listing exit, not a confirmed sale. Its price is the
last observed asking price. `listing_filters.py` defines property controls,
including price bounds, amenities and explicit Unknown values. Listing filters
apply before aggregation; operational run statistics keep their own scope.
Exit prices use event snapshots, while amenities use the latest listing details.

After changing definitions, run `node superset/scripts/generate-dashboard-catalog.js`
from the repository root, rebuild the Superset image, and rerun the seed and
access jobs. The generated [catalog](DASHBOARD_CATALOG.md) records the panel SQL,
filters and semantic datasets. CI verifies it matches the definitions.

## Native charts and maps

The seed provisions charts, datasets, layouts and filters. Chart selections intersect sidebar filters before aggregation. Market results cache for ten minutes; operational results are uncached. Charts retain their values during updates.

Native Deck.gl maps and viewer MapLibre maps use CARTO Dark Matter vector tiles.
Pins show listing details on hover and open OLX ads on click. No Mapbox key is
required. `patch_frontend.py` patches the pinned Superset frontend for vector
maps, chart selections and retained charts during refresh; the build fails if
the upstream patch targets change. Rebuilding hashes changed assets. The CSP
allows the CARTO endpoints and the sandboxed JavaScript tooltip/link controls.
Chart editing belongs to trusted administrators.

## Access and storage

`db/init-lean/zz-database-roles.sh` prepares the isolated `superset_meta` database
and owner login in the PostgreSQL cluster. Analytical queries connect as the
read-only `olx_reporting` role. The metadata role has no access to `olx` and is
capped at eight connections; the single web worker uses a bounded metadata pool.

`superset-access` prepares `OLX Viewer` from Gamma with managed chart and filter
dataset permissions and assigns it to the ten dashboards. `Public` has no
dashboard access. `OLX Guest` has only the custom-viewer permission for the three
market dashboards. Navigation includes only authorized dashboards. The viewer
rechecks authorization on cached responses and rejects changed dataset
definitions, embedded guest tokens, impersonation and unsupported
RLS policies; see [viewer limitations](../dashboard-viewer/README.md).

The alert-checker service evaluates SQL every 15 minutes and optionally sends
webhook firing/recovery transitions. Its state lives in Superset home. The
backup service creates verified `olx` and `superset_meta` dumps and a Superset
home archive. Keep `SUPERSET_SECRET_KEY` securely with `.env` for recovery.
Home-to-instance sync replaces `olx` and reconnects Superset. Provisioning during sync is optional; see [operations](../docs/OPERATIONS.md#home-machine-scrape-and-sync).

## Validation

Run these commands from the repository root on the dashboard host:

```bash
bash scripts/deploy-stack.sh --check
bash scripts/superset-readiness.sh --snapshot
```

Readiness checks viewer parity, authenticated API latency, temporary
viewer and guest permissions, revoked and anonymous access, and verified backups.
API budgets are two seconds fresh and one second cached. These checks exclude
browser rendering.

Native chart parity and API benchmarks are also available:

```bash
docker compose run --rm --no-deps --entrypoint python superset-seed /app/validate_parity.py
docker compose run --rm --no-deps --entrypoint python superset-seed /app/benchmark.py
```

Browser validation uses Playwright installed in ignored `data/superset-validation`:

```bash
npm install --prefix data/superset-validation --no-save playwright
node dashboard-viewer/tests/check-viewer.cjs
node superset/tests/check-ui.cjs
node superset/tests/check-cross-filters.cjs
node dashboard-viewer/tests/check-property-filters.cjs
```

Browser scripts share `tests/helpers/browser.cjs`, using installed Edge or Playwright Chromium. `SUPERSET_TEST_BROWSER` overrides the executable; `SUPERSET_TEST_URL` selects the origin. Credentials come from the environment or ignored `.env`. Artifacts stay in ignored `data/superset-validation/`.
