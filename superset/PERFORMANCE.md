# Dashboard performance

Measured locally on 2026-10-04. The React viewer is built and running at
`http://127.0.0.1:3000/olx/dashboard/olx-overview/` using the existing Superset
login. Production routing has not changed. The viewer now reuses host port 3000; the measurements below were collected before that port-only cutover.

**The 100–200 ms target is met for the tested repeated filters, but has not
been achieved for dashboard opening or a first-time filter.**

## Before and after

Time from navigation until the charts and tables in the initial viewport are
ready, in milliseconds:

| Dashboard | Original Superset, warm median | Optimized native Superset, warm median | React viewer, final warm median | Viewer warm range |
| --- | ---: | ---: | ---: | ---: |
| Home | 8,241 | 2,918 | 468 | 431–963 |
| Market Overview | 11,018 | 9,855 | 628 | 563–818 |
| Exits | 10,578 | 9,692 | 522 | 474–558 |
| Scraper Health | 10,977 | 5,518 | 481 | 453–610 |

The final viewer run contains ten opens per dashboard: the first forces a new
snapshot, and the next nine form the warm sample above. First forced opens were
3,461 ms for Home, 896 ms for Overview, 638 ms for Exits, and 1,222 ms for Health.
Home is the first viewer request after a service restart, with a fresh browser
context. Subsequent dashboards reuse the worker, reporting connection pool,
and browser assets; these are not four independent cold-start samples.

Earlier viewer runs recorded warm medians of 265–339 ms and a repeated-filter
median of 98 ms. The final figures above are retained rather than selecting the
fastest run. A synchronous chart-rendering experiment failed to improve the
timings and was reverted.

### Filtering

Overview room selection and clearing on an already open dashboard:

| Case | Final viewer time | Dashboard API requests |
| --- | ---: | ---: |
| First selection of two rooms | 376 ms | 1 |
| First return to the existing unfiltered snapshot | 181 ms | 0 |
| Six repeated selections/clears | 139 ms median; 126–152 ms range | 0 |

The original individual-request implementation issued 24 chart requests per
selection/clear. Its warmed runs took 4.2–6.3 seconds to finish **all** charts;
the optimized native implementation took 1.3–2.3 seconds with browser replay.
Those filter scripts wait for all charts, whereas the viewer timing waits for
the visible plots and tables, so these are different completion criteria.

## Changes

- React + Vite, selectively imported ECharts, TanStack Query and lazy MapLibre
  replace the dashboard presentation. Superset supplies authentication, permissions and administration. Viewer
  navigation contains only the four React dashboards.
- One read-only reporting data statement returns the entire dashboard and its
  filter options. Initial data is embedded in the authenticated HTML, avoiding
  a second browser data request during opening.
- Summary cards share their source aggregates. Repeated listing aggregates
  share materialized facts. Lifecycle lookups and limited detail tables retain
  their indexed physical scans. One statement still contains multiple logical
  aggregates; it does not mean every table is scanned only once.
- PostgreSQL JIT is disabled for these small aggregates. A bounded reporting
  pool reuses connections. Sidebar and chart selections use bound SQL values.
- Charts keep their instances and previous values during refresh. No chart
  spinner or empty replacement is inserted while new filter results arrive.
- Overview and Exits use account/role/dataset scoped ten-minute snapshots.
  Home and Health operational data is uncached. Refresh invalidates earlier
  filter snapshots for the account and dashboard.
- Authorization is rechecked even for cached data and HTML. Changed dataset
  SQL, guest access, impersonation and added RLS policies fail closed. See the
  [viewer limitations](../dashboard-viewer/README.md).
- The earlier native work preserves old charts, shares summary requests,
  batches queries, streams completed results, caches templates and reuses map
  results. Existing query/index changes are described in [README.md](README.md).

## Method and limits

Browser: headless installed Edge, 1440 × 1000, authenticated local loopback
origin. The native and viewer opening scripts both wait for visible chart
content rather than stopping at the API response. Offscreen lazy panels and
external map tiles are excluded from viewer opening latency; real vector map
loading is checked separately. Login time is excluded.

Original and optimized native samples each have three rounds, with two warm
rounds; medians are shown, with no p95 claim for those small samples. The final
viewer has nine warm rounds per dashboard and six repeated filter operations.
The source database remained active, so snapshots are not identical across
benchmark times. Data correctness is checked independently within a single
read-only repeatable-read snapshot.

Superset uses one gthread worker, a one-CPU/two-GB limit, and a bounded metadata
pool. PostgreSQL has a 0.75-CPU/two-GB limit. The viewer run uses the same
reporting database and previously added indexes as the native measurements.
Production HTTPS/network latency and concurrent-user behavior remain unmeasured.

Raw local results are in the ignored `data/superset-validation/` directory:

- `dashboard-baseline.json`: original native dashboard opens.
- `dashboard-final.json`: optimized native dashboard opens.
- `filter-individual.json`, `filter-shared.json`: native filter comparisons.
- `viewer-benchmark.json`: final viewer run with timestamps, viewport, request
  counts and server timing headers.
- `viewer-benchmark-before-layout.json`,
  `viewer-benchmark-layout-experiment.json`: earlier runs and the reverted
  rendering experiment.

## Remaining opening cost

### Viewer-only deployment gate after port retirement

The new `benchmark_viewer.py` gate passed on the port-3000 build. Each row has
ten forced fresh samples and, where caching is supported, ten cached samples:

| Authenticated dashboard API | Fresh p95 | Cached p95 |
| --- | ---: | ---: |
| Home | 89 ms | Uncached |
| Overview, all | 367 ms | 108 ms |
| Overview, rooms=2 | 220 ms | 142 ms |
| Exits, all | 253 ms | 112 ms |
| Exits, rooms=2 | 159 ms | 63 ms |
| Health | 88 ms | Uncached |

These are API timings, with browser rendering excluded. The gate retains the
2-second fresh / 1-second cached API budgets and does not establish the
100–200 ms browser target. The updated 55 Python tests, 21 deployment/security
contracts, and browser checks passed with the viewer as the root landing page,
only four dashboard navigation links, and Superset as the only dashboard provider.

### Browser opening

The final warm server handler medians were 101 ms (Home), 146 ms (Overview),
96 ms (Exits), and 122 ms (Health). Authorization accounted for 54, 141, 85,
and 99 ms respectively. Browser document completion and chart readiness add
further time. Cached Overview/Exits execute zero reporting data statements,
but still exceed 200 ms end to end.

Further work must reduce metadata/permission-query round trips, frontend
initialization, and cold connection/worker startup. Static chart previews or
application navigation could improve visible startup, but would need separate
measurements of first paint and interactive readiness. The current results do
not support promising 100–200 ms for fresh direct opens and every new filter.

## Validation

- 55 Python regression tests passed, including four viewer compiler tests.
- Seven native request-sharing tests passed.
- 266 comparisons covering all 71 panels passed against the source SQL,
  including sale/rent, area ranges, room selections and combined selections.
- Temporary viewer-account checks passed for all four viewer dashboards,
  including role revocation after cache population. Original publication was
  restored and the temporary account removed.
- Browser acceptance passed: real chart clicks and clearing, retained KPI and plotted chart values
  during a delayed response, vector tiles/local map worker, listing links,
  table sorting, CSV, CSP checks and a 390-pixel layout.
- The production image builds successfully; locked npm dependencies report
  zero vulnerabilities at build time.

Reproduction commands and runtime requirements are in the
[viewer README](../dashboard-viewer/README.md). For the full Python suite in
the local Compose environment, remove inherited development-origin settings
so deployment fixtures can supply their own production URLs:

```sh
docker compose --profile superset --profile superset-ops run --rm --no-deps \
  --entrypoint env -v ./:/repo:ro -v ./superset:/workspace/superset:ro \
  -v ./superset/dashboards:/workspace/superset/dashboards:ro \
  superset-seed -u SUPERSET_ROOT_URL -u SUPERSET_DOMAIN -u SUPERSET_COOKIE_SECURE \
  python -m unittest discover -s /workspace/superset/tests
node --test superset/tests/test_dashboard_requests.cjs
```
