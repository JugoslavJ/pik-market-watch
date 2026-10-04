# OLX dashboard viewer

React, selectively imported Apache ECharts, TanStack Query and MapLibre GL render
the four source dashboards (71 panels). Superset supplies login, permissions and the reporting API. Viewer navigation
contains only the four new dashboards. Source definitions are the existing Grafana JSON.

Build and run with the existing service:

```sh
docker compose --profile superset --profile superset-ops build superset
docker compose --profile superset --profile superset-ops up -d --no-deps superset
```

Open `http://127.0.0.1:3000/` (Market Overview) and use the existing
Superset login. Other routes end in `olx-home/`, `olx-exits/`, and `olx-health/`.
Opening a viewer without a session redirects to the configured Superset login
and returns to the dashboard after signing in. An expired data request retains
the existing charts and shows a sign-in link instead of a server error.
The Docker build installs the locked npm dependencies and builds hashed local
assets; no Node service or CDN JavaScript is required at runtime.

## Data and interactions

The authenticated `/olx/api/dashboard/<uid>` endpoint executes one read-only
data statement per dashboard. Summary cards share source aggregates. Repeated
listing aggregates share materialized facts; lifecycle lookups and limited
detail tables retain their physical indexes. Native filter scopes, time
windows, event populations and percentile calculations follow source SQL.
Chart selections filter facts before aggregation and intersect sidebar filters.

Charts remain mounted and retain their data during requests. Operational Home
and Health data is uncached; market and exit snapshots expire after ten minutes.
Refresh invalidates older filter snapshots for that account and dashboard.
Filters are reflected in the URL. Area edits apply on blur or Enter. Tables have
search, sorting, pagination, CSV export and OLX links. Maps load when visible,
use CARTO vector tiles, and update pins without recreating the map.

Every page opens with its Filters side panel collapsed. The Filters button
shows the active count; the panel supports search, Reset filters and Escape to
close, and becomes a drawer on phones. Property controls include BAM price and
price per m² bounds, lift, heating, condition, furnishing, parking, building
details and all currently collected OLX amenities. Missing details are shown as
Unknown. Property filters affect listing charts on Home and Health while run
statistics retain their operational scope. Exit prices use the event snapshot;
amenities use the latest listing details, which are not snapshotted on exits.

Authorization is rechecked before every data or cached page response. Dataset
definitions must match the provisioned source SQL. If an author changes those
definitions, reseed/rebuild or use Superset. Guest tokens and impersonated
connections are unsupported. If Superset RLS rules are added, this viewer denies
access until their policies are supported; the native Superset path remains
available. Browser data is never stored in persistent local storage.

## Validation and timings

```sh
npm ci
npm run build
node ../superset/tests/check-viewer.cjs
node ../superset/tests/benchmark-viewer.cjs
docker compose --profile superset --profile superset-ops run --rm --no-deps \
  --entrypoint python -v ./superset/validate_viewer.py:/app/validate_viewer.py:ro \
  superset-seed /app/validate_viewer.py
```

Run the Docker command from the repository root. Browser scripts use installed
Edge on Windows and the existing ignored Playwright installation in
`data/superset-validation`; they read the login secret without printing it.
See [performance measurements](../superset/PERFORMANCE.md) for methodology and
the remaining distance from the 100–200 ms target.
