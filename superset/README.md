# Superset dashboard stack

Superset 6.0.0 supplies authentication, permissions and reporting for the React viewer. The viewer is the only dashboard entry point and reuses host port 3000. See [the instance deployment runbook](../docs/SUPERSET_CUTOVER.md).

## Start for local review

Set `SUPERSET_META_PASSWORD`, `SUPERSET_ADMIN_PASSWORD`, and `SUPERSET_SECRET_KEY` in the ignored root `.env`, along with the existing PostgreSQL reporting credentials. Keep `SUPERSET_COOKIE_SECURE=false` when opening the loopback HTTP origin locally.

```bash
docker compose up -d db
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose --profile superset up -d db db-backup superset superset-alert-check
docker compose --profile superset run --rm superset-seed
docker compose --profile superset run --rm superset-access
```

Open `http://127.0.0.1:3000` and sign in as `admin`. Superset is authenticated; public signup is disabled and dashboards remain unpublished. The production deploy profile also requires `SUPERSET_BIND=127.0.0.1`, `SUPERSET_COOKIE_SECURE=true`, and an HTTPS `SUPERSET_ROOT_URL` reserved for the later tunnel cutover.

## Data and provisioning

The lightweight React viewer is available at
`/olx/dashboard/olx-overview/`, with Home, Exits and Health in its navigation.
It uses the existing login and retains Superset for exploration. See the
[viewer documentation](../dashboard-viewer/README.md) and
[performance measurements](PERFORMANCE.md). Rebuilding the Superset image also
builds the viewer; no additional runtime service is needed.

`db/init-lean/zz-database-roles.sh` idempotently creates the dedicated `superset_meta` database and `superset_meta` owner login on the existing PostgreSQL cluster. That role cannot connect to `olx`; Superset chart queries connect as the read-only `olx_reporting` role. The metadata login is capped at eight concurrent connections, and the single web worker uses a bounded pool to fit the cluster's 40-connection limit.

The seed preserves publication and role assignments when rerun. Shared `client.py`, `provisioning.py`, and `maps.py` helpers centralize API authentication, dataset/chart/dashboard updates, query contexts, filters, verification, and dark vector map controls. `parity.py` handles source translation and `seed.py` declares companion dashboards. The seed updates the named Superset connection, datasets, charts, filters, and dashboard from repository assets. Dataset SQL lives in `datasets/` plus `active-listings.sql`:

- `active_listings` contains current open listings and BAM-only asking prices.
- `active_listing_categories` is a separate one-row-per-listing/category bridge for exact saved-search category filtering; regular inventory counts remain one row per ad.
- `best_value_sales` ranks active BAM sale listings with positive price per square metre; rent and sale measures stay separate.
- `price_history` represents observed asking-price history; rent values are labeled monthly rent.
- `price_drops` pairs consecutive BAM asking-price observations and reports active ads with recorded reductions.
- `daily_market_summary` reconstructs the last 90 days of active sale asking prices per square metre with p25, median, and p75 statistics.
- `home_summary` reproduces the source Home market indicators in one cached query.
- `daily_inventory_flow` reproduces the source Home daily additions, exits, and estimated active inventory using Sarajevo local-day boundaries.
- `lifecycle_events` reports observed listing exits, not confirmed sales, using the event-time price snapshot.
- `recent_exits_30d` and `recent_exits_90d` reproduce the source exit summary and detail windows with event-time snapshots; `recent_exit_points` contains the geocoded 90-day subset for the map.
- `saved_searches`, `scrape_runs`, and `scrape_pages` support operational freshness and quality views; `scrape_run_summary` reports live 24-hour run totals, and `listing_quality` / `listing_quality_summary` expose uncached listing coverage and detail-backlog facts.

The seed also creates four native dashboards from the repository definitions: OLX.ba Home, OLX.ba Market Overview, OLX.ba Exits & Price Endings, and OLX Scraper Health. All 71 source panels have native counterparts: KPI cards, line charts, column charts, horizontal bars, scatter plots, listing tables, and vector pin maps. `parity.py` reads the JSON in superset/dashboards/ directly, translates source variables into scoped native filters, and preserves the original rolling time windows, units, row grouping, and panel widths. Chart heights provide room for axis labels and legends; KPI cards use explicit value/subtitle font sizes, and categorical bars display every label without a zoom slider. Dashboard-datasource KPI cards share their source summary dataset. Native sidebar filters apply inside the original SQL aggregates and retain the source filter scopes; chart selections reach every sibling. Market datasets use the ten-minute query cache. Operational datasets bypass chart caching with a `-1` second timeout. The private Market explorer, Home, Price history, Segments & rankings, Observed exits, and Scraper health dashboards are seeded. Market charts cover active inventory, segment counts, listing rankings, observed price history, and recorded price reductions. The complete source-panel inventory and alert predicates are in [`DASHBOARD_CATALOG.md`](DASHBOARD_CATALOG.md). The catalog records original query SQL, variables, time windows, units, links, owners, and target semantic datasets. Production comparison remains pending until a Superset chart comparison passes on the deployed instance against the same OLX snapshot.

Active and observed-exit Deck.gl maps use the CARTO Dark Matter vector style, including vector roads and labels, without a Mapbox key. Bright teal pins remain visible on the dark basemap. Source pin maps auto-fit their coordinates, show listing details on hover, and open OLX ads when clicked. Linked listing tables remain alongside the maps. The pinned Superset image includes a checked compatibility patch that lets Deck.gl mount its vector renderer for CARTO style URLs; its build fails if the upstream component changes. Changed frontend assets receive new cache hashes, and the content security policy permits the CARTO style, glyph, sprite, and vector tile endpoints. `script-src` also allows `unsafe-eval`, which Superset 6 requires to compile the enabled sandboxed JavaScript tooltip/link controls. Restrict chart editing to trusted authors. Rebuild the image after changing the frontend patch; restart Superset after changing its configuration. Compare map counts, bounds, tooltips, and rendering on the deployed version before cutover.

During a filter refresh, charts keep showing their last successful result until the new query completes. First loads still show Superset's loading indicator.

Both the viewer and all ten managed native dashboards use vertical filter side
panels collapsed by default. `listing_filters.py` defines shared property
controls, including price bounds, lift, heating, condition and the collected OLX
amenities, with raw attribute aliases and explicit Unknown values. Filters apply
to supported listing facts before aggregation; operational charts are excluded.
Exit price filters use the event price snapshot, while amenity filters use the
latest listing details. Rebuild Superset, rerun the seed and prepare access to
grant viewers the shared property-option dataset after changing these controls.

Dashboard query notes: the Home inventory-flow dataset shares one grouped listing-date scan between daily movements and estimated active counts. The live scraper summary is bounded to the last 24 hours and uses indexed lookup for the latest complete run. Price-history windows use the unique per-listing/per-day API price invariant, with an index that matches their article/date ordering. These query/index changes apply through the normal database migration and Superset seed; compare fresh and cached latency with the benchmark below after deployment.

The migration seed verifies dashboard filters, cross-filter settings, representative chart queries, a fresh filtered count, and a repeated cached query. The CI deploy then requires the Superset health check and a verified backup of both `olx` and `superset_meta`. CI checks that the generated dashboard catalog matches the source definitions.

After seeding, compare every native counterpart against the source SQL on the same read-only database:

```bash
docker compose --profile superset run --rm --no-deps --entrypoint python superset-seed /app/validate_parity.py
```

The comparison checks all 71 panels, sale/rent map and KPI filters, area ranges, repeated listing events, and room selections alone and combined with sidebar filters (173 comparisons). It fixes the time bounds for both queries and accounts for elapsed request time only in live scraper-age indicators. Browser validation additionally checks that maps fetch vector tiles and that the native chart types render. Production acceptance remains pending until these comparisons and browser checks pass on the deployed instance.

Cross-filtering is enabled on every dashboard. Selections from bars, pies, summary tables, and raw attribute tables are sent to every other chart on that page; click the selection again to clear it. Filters intersect with sidebar selections and reach KPI cards, detail tables, and maps. Chart selections also reach source measures without sidebar variables. Source and companion dataset SQL applies supported dimensions before aggregation so counts, medians, and closure ratios retain their meaning. Saved-search category clicks use listing membership without duplicating ads. Superset ignores dimensions that a dataset cannot interpret, such as listing rooms on scraper-run statistics. KPI cards and legacy maps receive selections; map pins open the ad. The pinned frontend patch in `patch_frontend.py` also corrects Superset 6's time-series click handler, which otherwise sends a metric label as the dimension value. The image build fails if either upstream patch target changes.

The optional browser regression checks dark vector tiles on all four maps, real pin hover/click interactions, CSP violations, KPI text size/overflow at two widths, and the floor chart height:

```bash
npm install --prefix data/superset-validation --no-save playwright
node superset/tests/check-ui.cjs
node superset/tests/check-cross-filters.cjs
```

It uses installed Edge on Windows. On other hosts, install Chromium with `node data/superset-validation/node_modules/playwright/cli.js install chromium`, or set `SUPERSET_TEST_BROWSER` to the browser executable. It reads the administrator password from the environment or the ignored root `.env`; screenshots go into ignored `data/superset-validation/`. `SUPERSET_TEST_URL` defaults to the local Superset origin.

Once dashboard parity is ready for performance review, run the OCI benchmark
against ten forced fresh and ten cached API queries for representative market,
exit, and health charts:

```bash
docker compose --profile superset run --rm --entrypoint python superset-seed /app/benchmark.py
```

It reports per-chart p95 latency and fails if fresh requests exceed 2 seconds
or cached requests exceed 1 second.

## Reverse proxy and permissions

The service is reachable on the host only at `127.0.0.1:3000`. The configured ProxyFix trusts the single local tunnel proxy for forwarded scheme and host headers, and secure session cookies are mandatory in production. Publish only after viewer acceptance. The `superset-access` job prepares `OLX Viewer` from Gamma with access to the managed chart and native-filter datasets, and assigns that role to the ten managed dashboards. Assign it to approved users in the Security UI; reserve author permissions for trusted administrators. The `Public` role has no dashboard access.

The seed preserves an existing published state and creates new dashboards as drafts. Run `docker compose run --rm superset-access --publish` explicitly for authenticated viewer acceptance; publication does not grant anonymous access. Publish only after the owner, access, link, map, mobile-layout, and performance checks for each dashboard have passed. Configure the Cloudflare tunnel to point at Superset only after the planned hostname, user login, HTTPS cookie, and rollback checks have passed. The existing port-3000 tunnel origin is reused.

## Backups and recovery

The production Compose profile runs the SQL alert checker every 15 minutes and backs up its transition state in the Superset home volume. The backup sidecar dumps `olx` and `superset_meta` separately as verified PostgreSQL custom archives and backs up the Superset home volume. `SUPERSET_SECRET_KEY` is not stored in those archives: retain it securely with the instance's ignored `.env` so stored connection credentials remain decryptable. The home-to-instance sync replaces schemas only inside `olx`; it does not include or overwrite `superset_meta`.

After a schema sync, `db/remote-restore.sh` refreshes only dashboards selected by `DASHBOARD_MODE`, reruns the seed when Superset is active, and requires a representative chart query before returning success. For a full recovery rehearsal, restore both database archives in a disposable stack, start Superset, and verify login, dashboards, and a chart query before considering the backup set usable.

## Operational readiness

Run `bash scripts/superset-readiness.sh --snapshot` on the dashboard host to
check source data, fresh/cached latency, real temporary viewer access, native
filter permissions, denied chart edits and anonymous access, and a fresh verified
backup. The temporary viewer is removed and original publication is restored
after the check. Run `bash scripts/deploy-stack.sh --check` for production
configuration preflight without service changes. Both use the shared mode helper.

Deployment starts Superset on port 3000 and runs the viewer readiness gates.
Cloudflare routing, real user provisioning, notification delivery, phone layouts,
and production recovery acceptance follow the cutover runbook.
