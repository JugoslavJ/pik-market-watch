# pik-market-watch Security Hardening — Agent Implementation Plan

## Objective

Implement the security, deployment, backup, restore, and operational hardening identified during the repository review of `pik-market-watch`.

This plan is designed for a **root/orchestrator agent** coordinating multiple implementation agents in parallel.

The goal is to preserve existing behavior while tightening trust boundaries and safe defaults.

---

# 1. Global Rules for All Agents

Every agent must follow these rules:

- Read this entire plan before changing code.
- Inspect the current repository state before modifying anything.
- Do not blindly apply an old patch if the repository has changed.
- Make the smallest change that satisfies the requirement.
- Do not refactor unrelated code.
- Preserve existing coding style and shell conventions.
- Do not weaken existing security controls.
- Do not introduce new runtime dependencies unless clearly justified.
- Update tests and documentation for behavior changes.
- Run the relevant focused test suite before reporting completion.
- Report:
  - files changed
  - behavior changed
  - tests run
  - test results
  - assumptions
  - unresolved risks/blockers

Never commit real credentials, private keys, tokens, host keys, or `.env` files.

---

# 2. Threat Model / Security Goals

The implementation should preserve the following trust boundaries:

```text
Untrusted fork PR
      |
      v
GitHub-hosted disposable CI runner
      |
      +-- no production secrets
      +-- no OCI SSH key
      +-- no production deployment
      +-- read-only GitHub token
      |
      X
Production deployment
```

Production deployment must instead follow:

```text
Trusted main branch
      |
      v
Successful CI
      |
      v
Protected GitHub production environment
      |
      v
Production secrets
      |
      v
Pinned SSH host verification
      |
      v
OCI deployment
```

Additional security goals:

- Grafana must not expose itself publicly by default.
- Example configuration must fail closed rather than start with known credentials.
- Health/status endpoints must not expose unnecessary sensitive configuration.
- OLX HTTP requests must stay on the intended trusted origin.
- Backup files must not appear valid until verification has completed.
- Restore uploads must have bounded size.
- Database identifiers loaded from `.env` must not be blindly interpolated.
- Restore credentials must be treated as privileged database-administration credentials.
- Database-only Docker networking should be isolated where possible.

---

# 3. Recommended Execution Graph

The root agent should execute the work roughly as follows:

```text
Phase 0
  A. Repository baseline + test inventory
              |
              v
Phase 1 — parallel
  B. CI/CD hardening
  C. Secret + Grafana default hardening
  D. Health endpoint hardening
  E. API/redirect hardening
  F. Backup hardening
  G. Restore hardening
              |
              v
Phase 2
  H. Docker network hardening
  I. Documentation updates
  J. Security policy
              |
              v
Phase 3
  K. Container vulnerability scanning
  L. Backup/restore validation tests
              |
              v
Phase 4
  M. Full integration review
```

Tasks B–G are mostly independent and can be delegated in parallel.

Task H should wait until agents C and D have finalized Docker/health behavior.

Task I should wait until the implementation behavior is stable.

Task M must be performed by the root/orchestrator agent.

---

# 4. Phase 0 — Baseline

## Task A — Baseline and Regression Inventory

**Owner:** root agent or dedicated reconnaissance agent

### Goal

Understand the current repository before implementation and capture a clean baseline.

### Actions

Inspect:

- `.github/workflows/`
- `.env.example`
- `docker-compose.yml`
- `scripts/deploy-stack.sh`
- `scraper/src/config.js`
- `scraper/src/index.js`
- `scraper/src/api.js`
- `db/backup.sh`
- `db/remote-restore.sh`
- `docs/OPERATIONS.md`
- `package.json`
- scraper tests
- integration tests
- existing shell tests, if any

Run the existing validation suite before changes.

Likely commands:

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:integration
```

Also run any repository-specific syntax/config checks already present in CI.

### Deliverable

Create a short baseline note for the root agent with:

- currently passing tests
- currently failing tests
- current branch / SHA
- any differences between repository state and this plan

Do not change production code in this task unless required to make baseline tooling runnable.

---

# 5. Phase 1 — Parallel Security Workstreams

## Task B — GitHub Actions / Deployment Hardening

**Primary files:**

- `.github/workflows/ci.yml`
- related workflow tests/documentation if present

### Goal

Ensure:

1. Pull requests may run untrusted code only in unprivileged CI.
2. Pull requests can never run the production deploy job.
3. Manual deployment is restricted to `main`.
4. Production credentials are attached only to a protected `production` environment.
5. SSH host verification fails closed.

### Required changes

Update the deploy condition from behavior equivalent to:

```yaml
github.event_name == 'workflow_dispatch' ||
(github.event_name == 'push' && github.ref == 'refs/heads/main')
```

to behavior equivalent to:

```yaml
github.ref == 'refs/heads/main' &&
(github.event_name == 'workflow_dispatch' || github.event_name == 'push')
```

Add:

```yaml
environment: production
```

to the deploy job.

Keep workflow permissions least-privileged.

Preserve:

```yaml
permissions:
  contents: read
```

or tighter equivalent.

Preserve:

```yaml
persist-credentials: false
```

where checkout credentials are not required.

### SSH host-key verification

Remove the `StrictHostKeyChecking=accept-new` / TOFU fallback.

`OCI_KNOWN_HOSTS` must be required for deployment.

Deployment must fail if it is empty.

Write it to:

```text
~/.ssh/known_hosts
```

with restrictive permissions.

All deploy SSH calls must use:

```text
StrictHostKeyChecking=yes
```

### SSH private key

Fail early if `OCI_SSH_PRIVATE_KEY` is empty.

Use restrictive permissions.

### Important constraint

Do **not** switch PR CI to `pull_request_target` while checking out and executing PR code.

Do **not** attach production secrets to jobs that execute pull-request code.

### Acceptance criteria

- Fork PR test job still works.
- PR job has no production deployment path.
- Deploy job cannot run from a non-`main` branch.
- Manual dispatch against a non-`main` ref is rejected/skipped.
- Deploy fails if `OCI_KNOWN_HOSTS` is missing.
- Deploy uses strict host-key verification.
- Workflow syntax validates.

### Root-agent GitHub configuration action

After code is merged, repository settings should be configured manually or via appropriate tooling:

```text
Settings
└── Environments
    └── production
        ├── Deployment branches
        │   └── main only
        ├── Environment secrets
        │   ├── OCI_HOST
        │   ├── OCI_USER
        │   ├── OCI_SSH_PRIVATE_KEY
        │   └── OCI_KNOWN_HOSTS
        └── Optional
            └── Required reviewer
```

If repository-level secrets currently exist for deployment, move them to environment-scoped secrets where practical.

---

## Task C — Secrets and Grafana Safe Defaults

**Primary files:**

- `.env.example`
- `docker-compose.yml`
- `scripts/deploy-stack.sh`
- relevant docs/tests

### Goal

Make insecure/example credentials impossible to accidentally deploy.

### Required changes

Remove real-looking placeholder values such as:

```text
change-me
change-me-app
change-me-reader
change-me-too
change-me-secret-key-too
```

Prefer blank required values in `.env.example`.

Example:

```dotenv
POSTGRES_PASSWORD=
POSTGRES_APP_PASSWORD=
POSTGRES_READER_PASSWORD=
GRAFANA_ADMIN_PASSWORD=
GRAFANA_SECRET_KEY=
```

### Grafana bind

Change the default Grafana host binding to loopback.

Preferred default:

```dotenv
GRAFANA_BIND=127.0.0.1
```

Compose fallback should also be safe:

```yaml
host_ip: ${GRAFANA_BIND:-127.0.0.1}
```

Remote access should require an explicit LAN/VPN/WireGuard address.

### Deployment preflight

`deploy-stack.sh` must reject:

- missing required secrets
- blank required secrets
- old example values such as `change-me` and `change-me-*`

Required secrets should include at least:

- `POSTGRES_PASSWORD`
- `POSTGRES_APP_PASSWORD`
- `POSTGRES_READER_PASSWORD`
- `GRAFANA_ADMIN_PASSWORD`
- `GRAFANA_SECRET_KEY`

Preserve any URL-safety requirement for passwords embedded into PostgreSQL URLs.

### Optional strengthening

If easy and backwards-compatible:

- reject leading/trailing whitespace
- enforce a reasonable minimum secret length
- detect accidental reuse between privileged credentials

Do not make these extra checks so strict that legitimate existing deployments break unexpectedly without documentation.

### Acceptance criteria

- Copying `.env.example` without filling secrets causes deployment/startup to fail.
- Known example credentials are rejected.
- Grafana is host-loopback-only by default.
- An explicit `GRAFANA_BIND` override still works.
- Existing Compose validation/tests pass.

---

## Task D — Health Endpoint Hardening

**Primary files:**

- `scraper/src/config.js`
- `scraper/src/index.js`
- `docker-compose.yml`
- scraper tests

### Goal

The health server must bind safely and expose only operationally necessary information.

### Required changes

Add a configurable health bind address.

Bare-metal/default behavior:

```text
HEALTH_BIND=127.0.0.1
```

Inside Compose, explicitly set:

```text
HEALTH_BIND=0.0.0.0
```

because Docker must reach the service inside the container while the host-side published port remains loopback-only.

### Health endpoint data

Do not expose raw configured search URLs unless they are strictly necessary.

Prefer health state such as:

```json
{
  "lastRun": "...",
  "lastSuccess": "...",
  "failedRuns": 0,
  "consecutiveFailures": 0,
  "intervalMinutes": 720,
  "searches": [
    { "name": "Example search" }
  ]
}
```

rather than:

```json
{
  "searches": [
    {
      "name": "...",
      "url": "..."
    }
  ]
}
```

### Routing

Prefer explicit health paths:

- `/`
- `/health`

Return `404` for unrelated paths.

Add:

```text
Cache-Control: no-store
```

to operational JSON.

### Logging

Log the actual configured bind address instead of claiming `localhost` when listening on all interfaces.

### Acceptance criteria

- Bare scraper binds to loopback by default.
- Dockerized scraper remains reachable through the configured host-loopback health port.
- Raw search URLs are absent from health JSON.
- `/health` returns expected status.
- Unknown paths return `404`.
- Failure-threshold health behavior remains unchanged.

---

## Task E — HTTP Origin / Redirect Hardening

**Primary files:**

- `scraper/src/api.js`
- API unit tests

### Goal

Prevent fetches from escaping the intended OLX origin.

### Required changes

Before every API `fetch()`, validate the target origin against the intended trusted API origin.

Expected behavior:

```js
if (target.origin !== API_ORIGIN) {
  throw new ApiError(...);
}
```

Set:

```js
redirect: "error"
```

or equivalent fail-closed redirect handling.

### Listing IDs

Validate article/listing IDs before constructing detail URLs.

Require:

- numeric
- positive
- safe integer

Construct the URL from the validated numeric ID.

### Preserve existing protections

Do not remove:

- existing URL reconstruction
- response size caps
- timeouts
- retry logic
- response ID validation
- rate limiting / pacing

### Tests

Add tests for:

- off-origin URL rejected
- redirect rejected
- malformed listing ID rejected
- negative ID rejected
- fractional ID rejected
- valid ID still works
- mismatched returned listing ID still fails

### Acceptance criteria

No untrusted/configurable value should be able to make the API layer fetch an arbitrary origin.

---

## Task F — Backup Atomicity / Permissions

**Primary files:**

- `db/backup.sh`
- backup tests if present

### Goal

Prevent incomplete archives from appearing as valid backups.

### Required changes

Add:

```sh
umask 077
```

Use a temporary filename while writing.

Example:

```text
olx-YYYYMMDD.dump.partial
```

Flow:

```text
pg_dump -> .partial
       |
       v
pg_restore -l verification
       |
       v
atomic mv
       |
       v
olx-YYYYMMDD.dump
```

Apply equivalent behavior to the Grafana state archive.

On failure:

- remove `.partial`
- do not leave the final backup filename behind

### Preserve

- retention behavior
- archive verification
- logging
- existing scheduling loop

### Optional improvement

If backups can overwrite same-day archives, decide whether overwriting is intentional.

If not intentional, consider timestamp granularity.

Do not change naming semantics without coordinating documentation and restore tooling.

### Acceptance criteria

- failed/terminated backup cannot leave a final-name corrupt archive
- successful backup becomes visible only after verification
- permissions are owner-only by default
- retention still works

---

## Task G — Remote Restore Hardening

**Primary files:**

- `db/remote-restore.sh`
- sync/restore scripts
- restore tests

### Goal

Treat restore access as privileged and prevent easy disk-exhaustion / interpolation abuse.

### Required changes

Add:

```sh
umask 077
```

### Maximum upload size

Introduce a configurable maximum restore archive size.

Suggested default:

```text
OLX_SYNC_MAX_BYTES=536870912
```

which is 512 MiB.

Read only up to:

```text
MAX_BYTES + 1
```

Then reject when:

```text
size > MAX_BYTES
```

Preserve existing minimum-size protection.

Do not use unbounded:

```sh
cat > incoming
```

for attacker-controlled restore input.

### Temporary file cleanup

Ensure the incoming restore archive is removed on all exit paths.

### Database config

Stop hardcoding database name `olx` if `.env` supports:

```text
POSTGRES_DB
```

Read the configured database name and use it consistently.

### PostgreSQL identifier validation

Validate these values before interpolation:

- application role
- reader role
- bootstrap/admin role
- database name

Accept only PostgreSQL-safe identifier syntax such as:

```regex
^[A-Za-z_][A-Za-z0-9_]{0,62}$
```

or a more correct equivalent if current repository conventions require it.

### Preserve restore safety

Do not weaken:

- restore lock
- archive listing validation
- expected table checks
- object ownership audit
- rollback snapshot
- scraper pause/restart
- single-transaction restore
- reader privilege reassertion

### Threat-model note

Document explicitly:

A holder of the restore SSH key must be treated as having **database-administrator-equivalent capability over application data**, even if the SSH account has no interactive shell.

### Acceptance criteria

- oversized input is rejected before filling disk
- undersized/truncated input still rejected
- invalid DB identifiers fail before destructive SQL
- configured `POSTGRES_DB` is honored
- incoming file is cleaned up
- failed restore still restarts scraper where appropriate
- rollback behavior remains intact

---

# 6. Phase 2 — Integration Hardening

## Task H — Docker Network Isolation

**Depends on:** C, D

**Primary file:**

- `docker-compose.yml`

### Goal

Keep the database network internal while preserving scraper/Grafana egress.

### Required change

If current topology confirms scraper and Grafana are dual-homed onto both:

- backend network
- default/egress-capable network

then mark the backend network:

```yaml
backend:
  internal: true
```

### Verify carefully

Before making this change, confirm:

- DB is only on backend
- scraper has backend + default
- Grafana has backend + default
- scraper can still reach OLX
- Grafana can still reach SMTP/external services if configured
- scraper/Grafana can still reach PostgreSQL over backend

### Acceptance criteria

- database is not attached to an egress-capable network
- scraper can still fetch OLX
- Grafana still starts and connects to PostgreSQL
- integration tests pass

If Compose topology has changed and this breaks required networking, report the issue instead of forcing the change.

---

## Task I — Documentation Updates

**Depends on:** B–H

**Primary files:**

- `docs/OPERATIONS.md`
- README where appropriate
- `.env.example` comments

### Document

1. Required secrets are intentionally blank in `.env.example`.
2. Grafana defaults to `127.0.0.1`.
3. Remote Grafana access requires explicit bind configuration.
4. `HEALTH_BIND` behavior.
5. GitHub `production` environment configuration.
6. `OCI_KNOWN_HOSTS` is mandatory.
7. Manual deployment is `main`-only.
8. Restore stream maximum size.
9. Restore key privilege level.
10. Backup verification/atomicity.
11. Recommended off-host backup strategy.
12. Recommended periodic restore testing.

### Acceptance criteria

Operational documentation matches actual code.

No docs should claim a control exists unless implementation verifies it.

---

## Task J — Add `SECURITY.md`

**Primary file:**

- `SECURITY.md`

### Goal

Provide a minimal responsible disclosure policy for the public repository.

### Suggested contents

- supported/current branch
- preferred private reporting channel
- request not to open public exploit details before coordination
- what information a useful report should contain
- acknowledgment that this is a personal/self-hosted project if applicable

Do not publish a personal email address unless the repository owner already uses it publicly and intentionally.

If GitHub private vulnerability reporting is enabled, direct researchers there.

### Acceptance criteria

`SECURITY.md` is concise, accurate, and does not promise response SLAs the maintainer cannot guarantee.

---

# 7. Phase 3 — Additional Defense in Depth

## Task K — Container Vulnerability Scanning

**Primary files:**

- `.github/workflows/ci.yml`
- possibly a dedicated workflow file

### Goal

Add OS/container-layer vulnerability visibility in addition to npm audit / CodeQL.

### Preferred tools

Use one well-supported tool such as:

- Trivy
- Grype
- Docker Scout

Do not add multiple redundant scanners.

### Requirements

- scan the actual built application image
- pin the scanner GitHub Action to a commit SHA where possible
- avoid sending secrets
- initially report findings without making CI unusably brittle

Recommended first-stage policy:

- fail on known fixable `CRITICAL`
- report `HIGH`
- ignore unfixed findings only if tool supports a clear and documented policy

Tune only after seeing real results.

### Acceptance criteria

- scanner runs in CI
- scanner covers OS/container packages, not only npm
- output is understandable
- policy is documented
- CI is not permanently broken by irrelevant/unfixable low-value findings

---

## Task L — Backup and Restore Validation Tests

**Primary areas:**

- backup scripts
- restore scripts
- disposable PostgreSQL test environment
- integration test scripts

### Goal

Prove recovery works, not merely that an archive can be listed.

### Tests to add

At minimum:

1. Create disposable test database.
2. Insert representative records.
3. Create backup.
4. Restore into a clean disposable database.
5. Verify expected tables.
6. Verify representative row counts/data.
7. Verify ownership.
8. Verify reader role has SELECT.
9. Verify oversized restore input is rejected.
10. Verify malformed archive is rejected.
11. Verify invalid identifier config is rejected.
12. Verify restore failure leaves/restarts writer service as expected where testable.

### Optional

Automate periodic restore testing separately from every PR if runtime cost is high.

---

# 8. Phase 4 — Root-Agent Integration

## Task M — Full Integration Review

**Owner:** root/orchestrator agent only

### Goal

Review every security boundary after merging agent work.

### Review checklist

#### GitHub Actions

- [ ] PR CI still executes tests
- [ ] PR CI cannot reach production environment
- [ ] PR CI has no production secrets
- [ ] deployment requires `main`
- [ ] manual deploy requires `main`
- [ ] `production` environment declared
- [ ] deployment checkout credentials not persisted
- [ ] permissions remain least-privileged
- [ ] SSH host key must be pinned
- [ ] no `accept-new` fallback

#### Secrets

- [ ] `.env.example` contains no usable example passwords
- [ ] missing secrets fail closed
- [ ] old `change-me*` values rejected
- [ ] credentials remain git-ignored

#### Grafana

- [ ] loopback default
- [ ] explicit remote bind still supported
- [ ] TLS behavior unchanged unless intentionally modified

#### Scraper health

- [ ] bare-metal default is loopback
- [ ] Compose health publishing still works
- [ ] raw search URLs not exposed
- [ ] health status semantics unchanged

#### HTTP API

- [ ] OLX origin fixed
- [ ] redirects fail closed
- [ ] listing IDs validated
- [ ] timeouts/retries/body caps preserved

#### Docker networking

- [ ] DB network internal
- [ ] DB reachable from scraper/Grafana
- [ ] scraper Internet egress works
- [ ] Grafana required egress works

#### Backups

- [ ] `umask 077`
- [ ] temporary archive during write
- [ ] verification before final rename
- [ ] failed archives removed
- [ ] retention still works

#### Restore

- [ ] `umask 077`
- [ ] max input size
- [ ] min input size
- [ ] identifier validation
- [ ] configurable DB name
- [ ] temporary file cleanup
- [ ] archive validation preserved
- [ ] rollback preserved
- [ ] scraper restart logic preserved

#### Documentation

- [ ] docs match actual defaults
- [ ] production environment setup documented
- [ ] restore credential sensitivity documented
- [ ] off-host backup recommendation documented
- [ ] `SECURITY.md` present

---

# 9. Required Final Validation

The root agent should run all existing project checks plus any newly added tests.

Likely:

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run test:integration
```

Also run:

```bash
docker compose config
```

and any repository shell syntax tests.

For changed shell files:

```bash
bash -n db/backup.sh
bash -n db/remote-restore.sh
bash -n scripts/deploy-stack.sh
```

If `shellcheck` is already available in the project/CI, run it.

For workflow YAML, use the project's existing validation or an Actions-aware linter if already available.

Do not add an unrelated validation dependency just for this task unless useful.

---

# 10. Security Regression Scenarios

The root agent should explicitly reason through these scenarios before declaring completion.

## Scenario 1 — Malicious fork PR

Attacker changes:

```json
{
  "scripts": {
    "preinstall": "malicious command"
  }
}
```

Expected:

- malicious command may run on disposable PR CI runner
- no OCI secrets available
- no protected environment available
- no deployment job runs
- no persistent self-hosted runner is used

## Scenario 2 — Contributor creates malicious branch

Contributor with repository write access creates:

```text
evil-deploy-branch
```

and manually dispatches workflow against it.

Expected:

- deployment job is skipped/rejected because ref is not `main`

## Scenario 3 — Missing host pin

`OCI_KNOWN_HOSTS` absent.

Expected:

- production deployment fails before SSH
- no `accept-new`

## Scenario 4 — Fresh `.env.example`

User copies `.env.example` and starts deployment without setting secrets.

Expected:

- startup/deploy fails
- Grafana is not exposed with known credentials

## Scenario 5 — Grafana default network exposure

No `GRAFANA_BIND` override.

Expected:

```text
127.0.0.1:3000
```

not:

```text
0.0.0.0:3000
```

## Scenario 6 — Health endpoint on bare metal

No `HEALTH_BIND`.

Expected:

```text
127.0.0.1
```

Health JSON must not reveal configured search URLs.

## Scenario 7 — HTTP redirect

Trusted OLX endpoint returns redirect to another origin.

Expected:

- request fails
- redirected destination is not fetched

## Scenario 8 — Oversized restore

Sender streams more than configured maximum.

Expected:

- restore aborts
- disk usage is bounded near configured maximum
- destructive database restore does not begin

## Scenario 9 — Corrupt backup

`pg_dump` or archive generation is interrupted.

Expected:

- only `.partial` exists transiently
- final backup filename does not appear
- `.partial` cleaned up where possible

---

# 11. Nice-to-Have Follow-Up Work

These items are useful but should not block the main hardening PR unless easy.

## Off-host encrypted backups

Add automated encrypted backup replication to a second system/provider.

Requirements:

- separate failure domain from production host
- encrypted in transit
- preferably encrypted at rest with a key not stored only on the same host
- retention policy
- restore documentation

## Automated periodic restore test

Run a scheduled recovery drill into an isolated disposable PostgreSQL instance.

Alert on:

- restore failure
- ownership mismatch
- expected-table absence
- unexpected row-count/data integrity failure

## Dependency runtime minimization

Review the scraper Dockerfile.

If npm/build tooling remains in the runtime image unnecessarily, consider:

- multi-stage build
- smaller runtime image
- removing package-manager tooling from final image

Do not make this change if it adds significant complexity for negligible benefit.

## Explicit DB grants

If the cluster ever hosts multiple databases, consider replacing broad roles such as:

```text
pg_read_all_data
```

with explicit database/schema/table grants.

For the current dedicated single-database deployment, this is lower priority.

## Data minimization

Review retained raw upstream JSON.

Consider:

- storing only fields used by the application
- redacting unnecessary seller/user metadata
- documenting retention purpose and duration

---

# 12. Suggested Agent Assignments

A good split for parallel execution:

```text
root
|
+-- agent-ci
|   +-- Task B
|
+-- agent-secrets-compose
|   +-- Task C
|
+-- agent-health
|   +-- Task D
|
+-- agent-api
|   +-- Task E
|
+-- agent-backup
|   +-- Task F
|
+-- agent-restore
|   +-- Task G
|
+-- root/agent-compose-integration
|   +-- Task H
|
+-- agent-docs
|   +-- Tasks I + J
|
+-- agent-container-security
|   +-- Task K
|
+-- agent-recovery-tests
    +-- Task L
```

Avoid having multiple agents edit the same file concurrently when possible.

Likely file collision risks:

```text
.github/workflows/ci.yml
  Task B
  Task K

docker-compose.yml
  Task C
  Task D
  Task H

docs/OPERATIONS.md
  Task I
```

Coordinate those changes through sequential integration or isolated worktrees.

---

# 13. Root-Agent Execution Prompt

Use this prompt with the implementation orchestrator:

```text
Read SECURITY_HARDENING_PLAN.md and execute it.

Act as the root/orchestration agent.

First:
- inspect the current repository
- run the baseline validation suite
- compare the current code with the plan
- identify any conflicts or stale assumptions

Then:
- delegate independent workstreams to subagents
- use isolated worktrees/branches where helpful
- prevent multiple agents from editing the same files concurrently
- keep security-sensitive boundary changes narrowly scoped

Each subagent must:
- read the relevant task section
- inspect current code before changing it
- implement only its assigned workstream
- add/update relevant tests
- run focused validation
- report changed files, tests, assumptions, and blockers

Do not weaken existing security controls.
Do not use pull_request_target for untrusted PR code.
Do not expose production secrets to pull-request jobs.
Do not introduce self-hosted PR runners.
Do not add permissive SSH host-key fallbacks.

After subagents finish:
- review every diff
- resolve integration conflicts
- verify the implementation against the threat model
- run the complete project test/lint/integration suite
- run docker compose config
- run shell syntax checks
- review documentation for accuracy
- verify every checklist item in Task M

If any proposed change would break current repository behavior because the code has changed since this plan was written, do not blindly force the plan. Preserve the security intent, adapt the implementation, and document the deviation.

At the end, produce:
1. completed tasks
2. changed files
3. security improvements
4. test/validation results
5. remaining risks
6. manual GitHub settings changes still required
7. recommended follow-up work
```

---

# 14. Definition of Done

This work is complete when:

- all high/medium-priority findings are implemented or explicitly dispositioned
- PR CI remains unprivileged
- non-main manual deployment is impossible
- deployment host keys are pinned
- secrets fail closed
- Grafana defaults to loopback
- health data is minimized
- API redirects/off-origin requests fail closed
- backups publish atomically
- restore stream is bounded
- restore config interpolation is validated
- database network isolation is verified
- public security reporting guidance exists
- CI includes container-layer scanning or a documented follow-up issue exists
- backup restore behavior is tested
- all existing and new tests pass
- documentation matches production behavior
