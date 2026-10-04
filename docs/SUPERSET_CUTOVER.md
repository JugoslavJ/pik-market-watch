# Deploy the React dashboards on OCI

The React viewer is the only dashboard entry point. Grafana is retired from
Compose, deployment, restore and backup requirements. Superset supplies login,
permissions, canonical datasets and the read-only reporting API.

## Port and public URL

- Host listener: `127.0.0.1:3000` (the former Grafana port).
- Superset container/network listener: `8088`.
- `/` opens Market Overview; navigation contains Home, Overview, Exits and Health.
- The existing public hostname and Cloudflare origin `http://127.0.0.1:3000`
  can stay unchanged. If the tunnel was moved to 8088, change it back to 3000.

Source JSON in `grafana/dashboards-lean/` remains the SQL/panel contract for the
71 panels. These files do not run Grafana or require Grafana credentials.

## Prepare the instance

1. Back up the current `olx` database, Superset metadata (if already present),
   and application state. Keep the existing `SUPERSET_SECRET_KEY` when upgrading
   an existing Superset installation.
2. In the instance's ignored `.env`, use the current dashboard hostname:

   ```dotenv
   DASHBOARD_MODE=superset
   COMPOSE_PROFILES=superset
   SUPERSET_BIND=127.0.0.1
   SUPERSET_DOMAIN=dashboards.example.com
   SUPERSET_ROOT_URL=https://dashboards.example.com/
   SUPERSET_COOKIE_SECURE=true
   ```

   Configure the required metadata, reporting, backup and administrator
   credentials from `.env.example`. Grafana credentials are unused. Remove
   `parallel`/`grafana` mode settings; preflight rejects retired modes.
3. Commit the complete implementation, including `dashboard-viewer/`,
   `superset/`, deployment helpers and the additive query-index migration.
   GitHub Actions ships tracked files only. Preserve the instance's ignored
   `.env`, search configuration and data volumes.
4. Configure the GitHub production environment's existing OCI deployment
   secrets and pinned host key as described in [OPERATIONS.md](OPERATIONS.md).
   The workflow builds on the instance's architecture.

## Deploy and retire Grafana

From the instance checkout, production preflight changes no services:

```bash
bash scripts/deploy-stack.sh --check
```

Merge the reviewed deployment commit to `main` to run the existing GitHub
Actions workflow, or run `bash scripts/deploy-stack.sh` after syncing the exact
tracked revision to the instance.

The deployment:

1. Repairs database ownership/grants and applies ordered migrations.
2. Initializes Superset metadata/security and finishes the image build.
3. Finds old Grafana containers using this stack's database container's Compose
   project label plus the `grafana` service label, then stops and removes those
   containers. Other projects are excluded; volumes are not deleted.
4. Starts Superset on host port 3000, its alert checker and backups, then seeds
   canonical datasets and viewer permissions.
5. Takes verified database/home-state backups and runs viewer acceptance gates.
6. Publishes the managed dashboards to authenticated viewers after gates pass.

Expect a dashboard interruption between releasing port 3000 and the new service
becoming ready. Grafana is not restarted by future deployments or database syncs.
The deployment fails if its migration, startup or acceptance gates fail.

## Verify the actual viewer

Readiness checks the new presentation's data path:

```bash
bash scripts/superset-readiness.sh --snapshot
curl -f http://127.0.0.1:3000/health
systemctl status cloudflared
```

The gate compares 266 results across all 71 panels against the source SQL,
benchmarks all four authenticated dashboard APIs (default and room-filtered
market/exit states), checks temporary viewer permissions and revoked access,
and verifies backups. API p95 budgets remain 2 seconds fresh / 1 second cached.
These API checks do not establish a 100–200 ms browser opening time.

Through the existing public HTTPS hostname, verify:

- `/` opens the viewer after login, and navigation shows only four dashboards.
- A real `OLX Viewer` account can open each board, with Secure session cookies.
- Native filters and chart clicks intersect; clearing restores the prior data.
- Old chart values remain visible during updates; expired sessions offer sign-in.
- Maps fetch vector tiles, listing links work, and CSV/sorting work on tables.
- Phone layouts, notification firing/recovery, and a complete scrape/sync cycle.

Browser checks can run from the Windows workstation against the HTTPS origin:

```powershell
$env:SUPERSET_TEST_URL='https://dashboards.example.com'
node superset/tests/check-viewer.cjs
$env:SUPERSET_BENCH_ROUNDS='10'
node superset/tests/benchmark-viewer.cjs
```

Use an existing administrative credential through the environment or ignored
local `.env`. Browser scripts require the local Edge/Playwright setup described
in [the viewer README](../dashboard-viewer/README.md).

## Recovery

Keep both database archives and Superset home backups, with the same encryption
key. Rehearse recovery in a disposable stack. To roll back a faulty viewer
release, redeploy a previous accepted viewer revision using port 3000; do not
switch to retired Grafana modes. Existing historical Grafana volumes/archives
are not automatically deleted by this deployment.

Local results and the remaining browser latency gap are recorded in
[PERFORMANCE.md](../superset/PERFORMANCE.md). Instance HTTPS and concurrent-user
performance must be measured on the actual instance.
