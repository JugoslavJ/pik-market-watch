# Superset dashboard service

Apache Superset 6.0.0 supplies authentication, permissions, administration and
reporting for the [React viewer](../dashboard-viewer/README.md). The viewer is
the dashboard entry point at `http://127.0.0.1:3000/`. Superset listens on port
8088 inside the container. Production serves the same loopback origin through
Cloudflare Tunnel; see [deployment](../docs/DEPLOYMENT.md).

## Start locally

Configure the required PostgreSQL and Superset credentials in the root `.env`
from `.env.example`. The volume command uses the default `POSTGRES_VOLUME_NAME`;
use your configured name if different. Local HTTP uses `SUPERSET_COOKIE_SECURE=false`.

```bash
docker volume create olx-price-ext_pgdata_pg18
docker compose up -d --build
docker compose run --rm superset-seed
docker compose run --rm superset-access
```

Sign in as `admin`. Public signup is disabled. The seed creates new native
dashboards as drafts and preserves existing publication and role assignments.
The production deployment publishes managed dashboards after readiness checks.
For a local authenticated viewer account, publish explicitly with
`docker compose run --rm superset-access --publish` and assign `OLX Viewer` to
the account. Publication does not grant anonymous access.

## Definitions and datasets

The four JSON files in `dashboards/` define 71 panels, scoped filter variables,
SQL, time windows, units and layouts. `viewer_queries.py` binds viewer selections
as SQL parameters and batches shared facts into one dashboard data statement.
`parity.py` compiles the same definitions into native Superset charts. Six
companion dashboards support exploration in Superset, for ten managed native
dashboards in total. Viewer navigation exposes Home, Overview, Exits and Health.

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

The seed provisions datasets, charts, dashboard layouts, collapsed vertical
filter panels and cross-filter scopes. Chart selections intersect sidebar
filters and reach supported facts before aggregation. Market datasets use a
ten-minute cache; operational datasets bypass chart caching. Charts retain
their previous successful values while updates run.

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
dashboard access. The viewer rechecks authorization on cached responses and
rejects changed dataset definitions, guest access, impersonation and unsupported
RLS policies; see [viewer limitations](../dashboard-viewer/README.md).

The alert-checker service evaluates SQL every 15 minutes and optionally sends
webhook firing/recovery transitions. Its state lives in Superset home. The
backup service creates verified `olx` and `superset_meta` dumps and a Superset
home archive. Keep `SUPERSET_SECRET_KEY` securely with `.env` for recovery.
Home-to-instance sync replaces only the `olx` database, then refreshes Superset,
reseeds charts and repairs viewer permissions.

## Validation

Run these commands from the repository root on the dashboard host:

```bash
bash scripts/deploy-stack.sh --check
bash scripts/superset-readiness.sh --snapshot
```

Readiness checks viewer/source parity, authenticated API latency, temporary
viewer permissions, revoked and anonymous access, and verified backups.
API budgets are two seconds fresh and one second cached. These checks exclude
browser rendering; see [measured performance](PERFORMANCE.md).

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

The viewer scripts use installed Edge on Windows. They read credentials from the
environment or ignored `.env`; `SUPERSET_TEST_URL` selects the origin. Screenshots
and timing artifacts stay in ignored `data/superset-validation/`.
