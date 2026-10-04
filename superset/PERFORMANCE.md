# Dashboard performance

The measurements below were collected locally on 2026-10-04 using the React
viewer and Superset login. They describe this implementation under the stated
conditions; production HTTPS and concurrent-user latency are not measured here.

The 100–200 ms target is met for tested repeated filters. Dashboard opening and
first-time filters exceed that target.

## Browser timings

Time from navigation until charts and tables in the initial viewport are ready:

| Dashboard | Warm median | Warm range | First forced open |
| --- | ---: | ---: | ---: |
| Home | 468 ms | 431–963 ms | 3,461 ms |
| Market Overview | 628 ms | 563–818 ms | 896 ms |
| Exits | 522 ms | 474–558 ms | 638 ms |
| Scraper Health | 481 ms | 453–610 ms | 1,222 ms |

The run contains ten opens per dashboard. The first forces a new snapshot;
the next nine form the warm sample. Home is the first viewer request after a
service restart in a fresh browser context. Subsequent dashboards reuse the
worker, reporting pool and browser assets, so these are not four independent
cold-start samples.

Overview room selection and clearing on an open dashboard:

| Case | Time | Dashboard API requests |
| --- | ---: | ---: |
| First selection of two rooms | 376 ms | 1 |
| Return to the existing unfiltered snapshot | 181 ms | 0 |
| Six repeated selections/clears | 139 ms median; 126–152 ms range | 0 |

## Authenticated API timings

`benchmark_viewer.py` measures ten forced fresh samples per state and ten
cached samples where caching is supported:

| Dashboard API | Fresh p95 | Cached p95 |
| --- | ---: | ---: |
| Home | 89 ms | Uncached |
| Overview, all | 367 ms | 108 ms |
| Overview, rooms=2 | 220 ms | 142 ms |
| Exits, all | 253 ms | 112 ms |
| Exits, rooms=2 | 159 ms | 63 ms |
| Health | 88 ms | Uncached |

These API timings exclude browser rendering. Deployment budgets are two seconds
fresh and one second cached; passing them does not establish the browser target.

## Runtime and method

The viewer executes one read-only reporting statement per fresh dashboard
snapshot, with shared facts and aggregates. The authenticated HTML embeds initial
data. Cached Overview/Exits snapshots execute zero reporting data statements;
authorization still runs. Home/Health operational data is uncached. Charts keep
their instances and previous values during requests. Maps load when visible.

Browser measurements use headless Edge at 1440 × 1000 on the authenticated local
loopback origin. They wait for visible chart content. Offscreen panels, external
map tiles and login are excluded; browser acceptance checks map loading separately.
The database remained active during measurement. Correctness comparisons run
independently in a single read-only repeatable-read snapshot.

Superset uses one gthread worker, a one-CPU/two-GB limit and a bounded metadata
pool. PostgreSQL uses a 0.75-CPU/two-GB limit. Warm handler medians are 101 ms
(Home), 146 ms (Overview), 96 ms (Exits) and 122 ms (Health). Authorization accounts
for 54, 141, 85 and 99 ms respectively. Document completion and chart rendering
add further time, so cached opens can still exceed 200 ms end to end.

The recorded artifacts are in ignored `data/superset-validation/`:
`viewer-benchmark.json` contains browser timestamps, viewport, request counts
and server timing headers. Reproduction commands and browser requirements are
in the [viewer README](../dashboard-viewer/README.md).

## Validation

Readiness compares all 71 panels against source SQL, benchmarks the four
authenticated dashboard APIs, validates temporary viewer access and revocation,
and verifies backups. Browser checks cover chart selection/clearing, retained
values during delayed responses, vector tiles, listing links, sorting, CSV,
CSP and mobile layout.

Run the offline Python regression suite and native request tests from the root:

```sh
docker compose run --rm --no-deps \
  --entrypoint env -v ./:/repo:ro -v ./superset:/workspace/superset:ro \
  superset-seed -u SUPERSET_ROOT_URL -u SUPERSET_DOMAIN -u SUPERSET_COOKIE_SECURE \
  python -m unittest discover -s /workspace/superset/tests
node --test superset/tests/test_dashboard_requests.cjs
```

Run live viewer acceptance on the dashboard host with
`bash scripts/superset-readiness.sh --snapshot`. It does not measure browser
opening latency or concurrent-user performance.
