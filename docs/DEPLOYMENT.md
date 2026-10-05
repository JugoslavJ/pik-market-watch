# Deploy the React dashboards on OCI

Deploy the React viewer and Superset authentication/reporting service.

## Port and public URL

- Host listener: `127.0.0.1:3000`.
- Superset container/network listener: `8088`.
- `/` opens Market Overview; navigation contains Home, Overview, Exits and Health.
- Cloudflare Tunnel forwards the public dashboard hostname to
  `http://127.0.0.1:3000`.

## Prepare the instance

1. Back up the current `olx` database, Superset metadata,
   and application state. Keep the existing `SUPERSET_SECRET_KEY` when upgrading
   an existing Superset installation.
2. In the instance's ignored `.env`, use the current dashboard hostname:

   ```dotenv
   COMPOSE_PROFILES=superset
   SUPERSET_BIND=127.0.0.1
   SUPERSET_DOMAIN=dashboards.example.com
   SUPERSET_ROOT_URL=https://dashboards.example.com/
   SUPERSET_COOKIE_SECURE=true
   ```

   Configure the required metadata, reporting, backup and administrator
   credentials from `.env.example`.
3. GitHub Actions ships tracked files only. Preserve the instance's ignored
   `.env`, search configuration and data volumes.
4. Configure the GitHub production environment's existing OCI deployment
   secrets and pinned host key as described in [OPERATIONS.md](OPERATIONS.md).
   The workflow builds on the instance's architecture.

## Deploy Superset

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
3. Starts Superset on host port 3000, its alert checker and backups, then seeds
   canonical datasets and viewer permissions.
4. Takes verified database/home-state backups and runs viewer acceptance gates.
5. Publishes the managed dashboards to authenticated viewers after gates pass.

Expect a dashboard interruption while the new service becomes ready.
The deployment fails if its migration, startup or acceptance gates fail.

## Verify the actual viewer

Readiness checks the viewer data path:

```bash
bash scripts/superset-readiness.sh --snapshot
curl -f http://127.0.0.1:3000/health
systemctl status cloudflared
```

The gate checks all 71 panels against source SQL, API latency, temporary viewer permissions, revoked access and backups. API p95 budgets are 2 seconds fresh / 1 second cached; browser timings are measured separately.

Through the existing public HTTPS hostname, verify:

- `/` opens the viewer after login, and navigation shows only four dashboards.
- A real `OLX Viewer` account can open each board, with Secure session cookies.
- Sidebar filters and chart clicks intersect; clearing restores the prior data.
- Previous chart values remain visible during updates; expired sessions offer sign-in.
- Maps fetch vector tiles, listing links work, and CSV/sorting work on tables.
- Phone layouts, notification firing/recovery, and a complete scrape/sync cycle.

Browser checks can run from the Windows workstation against the HTTPS origin:

```powershell
$env:SUPERSET_TEST_URL='https://dashboards.example.com'
node dashboard-viewer/tests/check-viewer.cjs
$env:SUPERSET_BENCH_ROUNDS='10'
node dashboard-viewer/tests/benchmark-viewer.cjs
```

Use an existing administrative credential through the environment or ignored
local `.env`. Browser scripts require the local Edge/Playwright setup described
in [the viewer README](../dashboard-viewer/README.md).

## Recovery

Keep both database archives and Superset home backups, with the same encryption
key. Rehearse recovery in a disposable stack. To roll back a faulty viewer
release, redeploy a previous accepted viewer revision using port 3000.

Local results and the remaining browser latency gap are recorded in
[PERFORMANCE.md](../superset/PERFORMANCE.md). Instance HTTPS and concurrent-user
performance must be measured on the actual instance.
