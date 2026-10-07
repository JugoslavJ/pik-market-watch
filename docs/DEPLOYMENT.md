# Deployment

Production runs the Compose stack on an OCI instance behind Cloudflare Tunnel. GitHub Actions deploys every tested push to `main`.

- Superset listens on container port `8088`, published on host `127.0.0.1:3000`.
- `/` opens Market Overview; navigation contains Home, Overview, Exits and Health.
- Cloudflare Tunnel forwards the public hostname to `http://127.0.0.1:3000`. No public 80, 443 or 3000 ingress is needed.

## Prepare the instance

1. Create the deployment directory with its ignored configuration: `.env` and `config/searches.json`. Set the [secrets](CONFIGURATION.md#secrets) and the public hostname:

   ```dotenv
   COMPOSE_PROFILES=superset
   SUPERSET_BIND=127.0.0.1
   SUPERSET_DOMAIN=dashboards.example.com
   SUPERSET_ROOT_URL=https://dashboards.example.com/
   SUPERSET_COOKIE_SECURE=true
   ```

2. Install and configure `cloudflared` on the host, pointing the tunnel at `http://127.0.0.1:3000`. The repository does not manage `cloudflared`, OCI networking or Cloudflare; keep tunnel credentials in protected host configuration. Cloudflare Access can optionally protect the hostname.
3. In the GitHub `production` environment, set `OCI_HOST`, `OCI_USER`, `OCI_SSH_PRIVATE_KEY` and the pinned `OCI_KNOWN_HOSTS`. Use a dedicated deployment key whose `authorized_keys` entry allows the workflow's shell commands, never the restore-only sync key. Restrict the environment to the `main` branch and consider a required reviewer.

When upgrading an existing installation, back up first and keep its `SUPERSET_SECRET_KEY`.

## CI and rollout

CI runs on pull requests and on pushes to `main` that change more than Markdown or `docs/`. It checks formatting, lint, unit, contract and integration tests, the dashboard catalog, the Superset Python tests and the reporting fixture, and builds both images. Trivy scans the scraper image; HIGH and CRITICAL findings are reported but do not fail the build yet.

On `main`, the deploy job ships tracked files to the instance with `git archive`. It deletes only files that a previous deployment shipped and the new revision dropped, never ignored configuration, backups, logs or volumes. It then runs `scripts/deploy-stack.sh`, which:

1. Builds the scraper and Superset images once, repairs database ownership and grants, and applies migrations.
2. Upgrades Superset metadata.
3. Starts Superset, the alert checker and backups, then seeds datasets and viewer permissions.
4. Takes and verifies a fresh backup, and runs the readiness gates.
5. Publishes the managed dashboards once the gates pass.

Dashboards are briefly unavailable while Superset restarts. Any failed migration, startup or gate fails the deployment. To check configuration without changing services, or to deploy by hand after syncing the exact revision:

```bash
bash scripts/deploy-stack.sh --check
bash scripts/deploy-stack.sh
```

To roll back, redeploy the last good commit.

## Verify

```bash
bash scripts/superset-readiness.sh --snapshot
curl -f http://127.0.0.1:3000/health
systemctl status cloudflared
```

Readiness compares all 63 viewer panels with their definition SQL run directly against the database, and checks API latency (p95 under 2 s fresh, 1 s cached), temporary viewer and guest permissions, revoked access and backups. It does not measure browser rendering.

Then, through the public hostname:

- `/` opens the viewer after login, and navigation lists only authorized dashboards.
- An `OLX Viewer` account opens every dashboard, with Secure session cookies.
- An `OLX Guest`-only account opens Home, Market Overview and Exits; Health and the native Superset data APIs are denied.
- Sidebar filters and chart clicks combine, and clearing restores the previous data.
- Charts keep their values while updating, and expired sessions offer sign-in.
- Maps load, listing links open, and tables sort and export CSV.
- Phone layout, alert firing/recovery, and a full scrape or sync cycle work.

Browser checks can run from a workstation against the public origin, using an administrator credential from the environment or the ignored `.env`:

```powershell
$env:SUPERSET_TEST_URL='https://dashboards.example.com'
node dashboard-viewer/tests/check-viewer.cjs
node dashboard-viewer/tests/benchmark-viewer.cjs
```

They need the Playwright setup described in the [viewer README](../dashboard-viewer/README.md).
