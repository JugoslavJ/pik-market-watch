# OLX dashboard viewer

React, ECharts, TanStack Query and MapLibre GL render four dashboards with 71 panels. Superset supplies authentication and reporting; `superset/dashboards/` holds the definitions.

Build and run with the existing service:

```sh
docker compose --profile superset --profile superset-ops build superset
docker compose --profile superset --profile superset-ops up -d --no-deps superset
```

Open `http://127.0.0.1:3000/` (Market Overview) and use the existing
Superset login. Other routes end in `olx-home/`, `olx-exits/`, and `olx-health/`.
Unauthenticated visits redirect to Superset login. Expired data requests retain charts and show a sign-in link. Docker builds hashed local assets; runtime needs no Node service or CDN JavaScript.

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

The Filters panel starts collapsed, supports search/reset/Escape and becomes a phone drawer. Controls cover BAM price, area, building details and amenities; missing values appear as Unknown. Home/Health listing charts use property filters; run statistics retain their operational scope. Exit prices use event snapshots, while amenities use current listing details.

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
npm run test:browser
node tests/benchmark-viewer.cjs
docker compose --profile superset --profile superset-ops run --rm --no-deps \
  --entrypoint python -v ./superset/validate_viewer.py:/app/validate_viewer.py:ro \
  superset-seed /app/validate_viewer.py
```

Run the Docker command from the repository root. Browser scripts use installed Edge, falling back to Playwright Chromium. Set `SUPERSET_TEST_BROWSER` to choose an executable. Install Playwright with
`npm install --prefix data/superset-validation --no-save playwright` from the
repository root; they read the login secret without printing it. Shared configuration lives in `tests/helpers/browser.cjs`.
See [performance measurements](../superset/PERFORMANCE.md) for timings and methodology.
