# Superset dashboard service

Apache Superset 6.0.0 provides authentication and administration for the [React viewer](../dashboard-viewer/README.md) at `http://127.0.0.1:3000/` (container port 8088). Superset itself holds no dashboards, charts or datasets; the viewer queries the reporting database directly. Production uses [Cloudflare Tunnel](../docs/DEPLOYMENT.md).

## Terms

- **Dashboard definition**: one JSON file per dashboard in [`dashboards/`](dashboards/README.md) (`olx-home`, `olx-overview`, `olx-exits`, `olx-health`). It holds the panels, filter variables, time windows, units and layout, and is the single source of panel SQL.
- **Panel**: one big number, chart, table or map in a definition. A panel either has its own SQL or reuses another panel's query (`source_panel`).
- **Definition SQL**: a panel's query, using the filter and time [macros](dashboards/README.md) that the compiler expands.
- **Viewer**: the React app at `/olx/dashboard/<uid>/`. `viewer_queries.py` compiles each dashboard into one batched, parameterized statement that `viewer.py` runs as the read-only `olx_reporting` role.
- **Parity**: the guarantee that the viewer returns the same results as each panel's definition SQL. `validate_viewer.py` checks it against a live database.

## Accounts and access

Start the stack as described in the [README](../README.md#start-locally), then sign in as `admin`. Public signup is disabled. Assign one of two roles through `/users/list/`:

| Role | Dashboards |
| --- | --- |
| `OLX Viewer` | Home, Market Overview, Exits, Health |
| `OLX Guest` | Home, Market Overview, Exits |

Admins see every dashboard. Role membership, not permissions, opens a dashboard: `superset init` grants Alpha and Gamma every custom permission, so Gamma, Alpha and other roles open nothing in the viewer. The two roles hold no Superset permissions, so they have no access to Superset's own dashboards, charts, datasets or SQL Lab. Navigation lists only the dashboards a role opens, and the viewer rechecks roles on every response, including cached ones. Embedded guest tokens are denied.

`superset-access` creates both roles and strips any permissions they hold. It also removes the retired native Superset dashboards, with their charts, datasets and reporting connection where nothing else uses them, and the former `OLXDashboard` permissions:

```sh
docker compose --profile superset --profile superset-ops run --rm --no-deps superset-access
```

## Definitions

The four JSON files in `dashboards/` define 63 panels, scoped filter variables, SQL, time windows, units and layouts. `definitions.py` reads them and pushes chart selections and property filters into source table scans. `viewer_queries.py` binds viewer selections as SQL parameters and batches shared facts into one dashboard data statement.

A closure is an observed listing exit, not a confirmed sale. Its price is the last observed asking price. `listing_filters.py` defines property controls, including price bounds, amenities and explicit Unknown values. Listing filters apply before aggregation; operational run statistics keep their own scope. Exit prices use event snapshots, while amenities use the latest listing details. Market and exit results cache for ten minutes; Home and Health are uncached.

After changing definitions, run `node superset/scripts/generate-dashboard-catalog.js` from the repository root and rebuild the Superset image. The generated [catalog](DASHBOARD_CATALOG.md) records the panel SQL, filters and result groups. CI verifies it matches the definitions.

## Storage

`db/init-lean/zz-database-roles.sh` prepares the isolated `superset_meta` database and owner login in the PostgreSQL cluster. The viewer connects as the read-only `olx_reporting` role with a pool of two connections. The metadata role has no access to `olx` and is capped at eight connections; the single web worker uses a bounded metadata pool.

The alert-checker service evaluates SQL every 15 minutes and optionally sends webhook firing/recovery transitions. Its state lives in Superset home. The backup service creates verified `olx` and `superset_meta` dumps and a Superset home archive. Keep `SUPERSET_SECRET_KEY` securely with `.env` for recovery. Home-to-instance sync replaces `olx` and reconnects Superset; see [operations](../docs/OPERATIONS.md#home-machine-scrape-and-sync).

## Validation

Run these commands from the repository root on the dashboard host:

```bash
bash scripts/deploy-stack.sh --check
bash scripts/superset-readiness.sh --snapshot
```

Readiness checks viewer parity, authenticated API latency, temporary Viewer, Guest and Gamma-only accounts, revoked and anonymous access, and verified backups. API budgets are two seconds fresh and one second cached. These checks exclude browser rendering.

Browser validation uses Playwright installed in ignored `data/superset-validation`:

```bash
npm install --prefix data/superset-validation --no-save playwright
node dashboard-viewer/tests/check-viewer.cjs
node dashboard-viewer/tests/check-property-filters.cjs
```

Browser scripts share `tests/helpers/browser.cjs`, using installed Edge or Playwright Chromium. `SUPERSET_TEST_BROWSER` overrides the executable; `SUPERSET_TEST_URL` selects the origin. Credentials come from the environment or ignored `.env`. Artifacts stay in ignored `data/superset-validation/`.
