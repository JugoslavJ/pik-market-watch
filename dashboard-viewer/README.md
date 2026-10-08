# OLX dashboard viewer

React, ECharts, TanStack Query and MapLibre GL render eight dashboards with 142 panels. Superset supplies authentication and reporting; `superset/dashboards/` holds the definitions.

The viewer is built into the Superset image. Rebuild and restart that service:

```sh
docker compose --profile superset --profile superset-ops build superset
docker compose --profile superset --profile superset-ops up -d --no-deps superset
```

Open `http://127.0.0.1:3000/` (Home) and sign in with a Superset account.
Other routes end in `olx-buyer/`, `olx-renter/`, `olx-daily/`, `olx-pro/`, `olx-overview/`,
`olx-exits/` and `olx-health/`.
Unauthenticated visits redirect to Superset login. Expired data requests retain charts and show a sign-in link. Docker builds hashed local assets; runtime needs no Node service or CDN JavaScript.

Each role opens a fixed set of dashboards (see
[accounts and access](../superset/README.md#accounts-and-access)); other dashboards are omitted from navigation and denied on
direct page/API requests. Assign roles through Superset's `/users/list/`
administration page; see [accounts and access](../superset/README.md#accounts-and-access).

## Data and interactions

The authenticated `/olx/api/dashboard/<uid>` endpoint executes one read-only
data statement per dashboard. Summary cards share source aggregates. Repeated
listing aggregates share materialized facts; lifecycle lookups and limited
detail tables retain their physical indexes. Filter scopes, time
windows, event populations and percentile calculations follow source SQL.
Chart selections filter facts before aggregation and intersect sidebar filters.

Charts remain mounted and retain their data during requests. Operational Home
and Health data is uncached; market and exit snapshots expire after ten minutes.
Refresh invalidates older filter snapshots for that account and dashboard.
Filters are reflected in the URL. Area edits apply on blur or Enter. Tables have
search, sorting, pagination, CSV export and OLX links. Maps load when visible,
use CARTO vector tiles, and update pins without recreating the map.

Filters with a `section` (the price-check inputs) render above that section instead of in the Filters panel. A `text` filter accepts an OLX.ba link or listing id. Area maps (`view.layer: "areas"`) color neighborhoods by the panel `value` and filter the page on click.

The header switches between English and Serbian; the choice is kept in the URL (`lang`) and the browser. **Report** opens `?report=1`: a fixed-width page with a cover (scope in words, data date, the exits caveat), every panel drawn, tables capped at 25 rows, and a print/PDF button. An optional "Prepared by" block (name, company, contact, logo) stays in browser storage and is never sent to the server.

The Filters panel starts collapsed, supports search/reset/Escape and becomes a phone drawer. Controls cover BAM price, area, building details and amenities; missing values appear as Unknown. Home/Health listing charts use property filters; run statistics retain their operational scope. Exit prices use event snapshots, while amenities use current listing details.

Authorization is rechecked before every data or cached page response. Data is
read as the read-only `olx_reporting` role; Superset row-level security rules
do not apply to the viewer. Embedded guest tokens are unsupported. Browser data
is never stored in persistent local storage.

## Validation

```sh
npm ci
npm run build
npm run test:browser
node tests/benchmark-viewer.cjs
docker compose --profile superset --profile superset-ops run --rm --no-deps \
  --entrypoint python superset-access /app/validate_viewer.py
```

Run the Docker command from the repository root. Browser scripts use installed Edge, falling back to Playwright Chromium. Set `SUPERSET_TEST_BROWSER` to choose an executable. Install Playwright with
`npm install --prefix data/superset-validation --no-save playwright` from the
repository root; they read the login secret without printing it. Shared configuration lives in `tests/helpers/browser.cjs`.
