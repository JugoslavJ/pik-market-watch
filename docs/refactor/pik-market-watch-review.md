# pik-market-watch — Code Review & Improvement Backlog

**Repository:** https://github.com/JugoslavJ/pik-market-watch  
**Reviewed:** 2026-09-06  
**Scope:** `scraper/`, `db/`, Docker Compose, CI, and project documentation on the public `main` branch.

> This is a static source review, not a production benchmark. Performance items below are ranked by likely cost based on code paths and database round-trips. Measure before/after on realistic data before treating any timing estimate as fact. Line numbers are indicative and may drift as the repository changes.

---

## Executive summary

This is already a well-structured project in the places that matter most for correctness:

- ingestion is transaction-oriented;
- advisory locking protects search lifecycle races;
- detail jobs use bounded leasing / `SKIP LOCKED`;
- raw API evidence is retained separately from normalized state;
- the analytics rebuild is deliberately designed rather than being a pile of dashboard queries;
- integration tests cover lifecycle and persistence semantics;
- Docker hardening and operational documentation are stronger than typical for a project of this size.

The largest improvement opportunity is **not a rewrite**. It is to preserve those invariants while reducing database round-trips and making the two largest orchestration modules easier to reason about.

### Highest-value changes

| Priority | Area | Recommendation | Expected impact | Effort |
|---|---|---|---|---|
| **P1** | DB performance | Bulk listing upserts in `commitSearchIngestion()` | High | Medium |
| **P1** | DB performance | Bulk state-observation inserts | High | Medium |
| **P1** | DB performance | Bulk price-event inserts after classification | High | Medium |
| **P1** | Readability | Split `scraper/src/db.js` behind a thin compatibility facade | High | Medium |
| **P1** | Readability | Split `scraper/src/scraper.js` into harvest / commit / enrichment stages | High | Medium |
| **P2** | HTTP/rate limiting | Make request pacing semantics explicit and centralize rate-limit state | Medium | Medium |
| **P2** | DB performance | Batch detail-response archival / completion writes | Medium | Low–Medium |
| **P2** | DB indexing | Profile `enrichmentQueue()` and add a targeted partial index only if justified | Medium | Low |
| **P2** | Correctness/readability | Canonicalize search-query parameter order in search keys | Low–Medium | Low |
| **P2** | Docs/CI | Fix stale/broken references and add Markdown link checking | Medium maintainability | Low |
| **P3** | Operations | Optionally decouple heavier maintenance from the scrape hot path | Workload-dependent | Low–Medium |
| **P3** | Compose | Add one restrained common service anchor | Low | Low |

If only three changes are made, I would do:

1. **bulk ingestion writes**;
2. **split `db.js` and `scraper.js` without changing behavior**;
3. **add a repeatable ingestion benchmark/query-count harness**.

---

# 1. What should remain largely as-is

A useful refactor plan also identifies code that does **not** need churn.

## Transactional ingestion boundary

`commitSearchIngestion()` has the right high-level shape: collect the page results, enter one database transaction, protect lifecycle-sensitive work with an advisory lock, persist the current state/evidence, and then commit.

Keep that atomic boundary while optimizing its implementation.

**Do not** turn each write into independently committed async work just to gain concurrency. That would trade a performance problem for correctness problems.

## Detail-job leasing

The detail queue uses bounded claims with `FOR UPDATE SKIP LOCKED`. That is a strong concurrency pattern and should remain the ownership mechanism if multiple workers are ever introduced.

## Raw evidence vs normalized state

The project distinguishes:

- current listing state;
- search membership;
- price/history events;
- raw API responses.

That separation is valuable for debugging and rebuilding state. Avoid collapsing it merely to reduce table count.

## Daily analytics rebuild

`db/init/06-rebuild.sql` is already intentionally optimized:

- JIT is disabled for the rebuild;
- intermediate sets are materialized;
- sparse history is folded per cutoff;
- geography inputs are reduced before resolution.

Do **not** rewrite this first. Profile it under realistic history volume and only optimize if it actually becomes a bottleneck.

## Dependency footprint

The runtime dependency surface is tiny (`pg` plus Node built-ins). That is a strength. An ORM or large framework is unlikely to pay for itself here.

---

# 2. Performance improvements

## P1 — Bulk the hot-path writes in `commitSearchIngestion()`

**File:** `scraper/src/db.js`  
**Area:** roughly the body of `commitSearchIngestion()`

The current ingestion flow performs individual awaited statements for each listing and each state observation. Price-history persistence can then perform another individual insert for each newly classified price event.

For `N` cards, the hot path is therefore roughly:

```text
N listing upserts
+ N state-observation inserts
+ up to N price-event inserts
+ a small constant number of lifecycle/membership queries
```

At the configured search ceiling of approximately `30 pages × 40 cards = 1,200 cards`, the theoretical upper bound is therefore on the order of **thousands of round-trips for a single complete search ingestion**.

The database work itself may be cheap; network/protocol/parse/execute latency repeated thousands of times is the avoidable part.

### Recommended shape

Keep the existing transaction and advisory lock, but change the per-row loops into set-based statements.

A readable approach in PostgreSQL is `jsonb_to_recordset()`:

```sql
WITH input AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS x(
    article_id bigint,
    url text,
    title text,
    price numeric,
    sqm numeric,
    ppm2 numeric,
    location text
  )
)
INSERT INTO listings (
  article_id,
  url,
  title,
  price,
  sqm,
  ppm2,
  location
)
SELECT
  article_id,
  url,
  title,
  price,
  sqm,
  ppm2,
  location
FROM input
ON CONFLICT (article_id) DO UPDATE
SET
  url = EXCLUDED.url,
  title = EXCLUDED.title,
  price = EXCLUDED.price,
  sqm = EXCLUDED.sqm,
  ppm2 = EXCLUDED.ppm2,
  location = EXCLUDED.location;
```

The exact column set should match the current upsert semantics. The important property is:

```text
one batch statement per entity type
```

rather than:

```text
one statement per entity
```

`unnest()` is also fine, and the project already uses it elsewhere. Prefer whichever produces the clearest SQL with the current row shape.

### Suggested decomposition

Inside the same transaction:

```text
1. load prior membership/current rows
2. bulk upsert listings
3. bulk insert state observations
4. classify + bulk insert price events
5. bulk reopen lifecycle rows if needed
6. bulk replace current search membership
7. persist run/page state
8. commit
```

### Acceptance criteria

- all current integration tests stay unchanged and pass;
- incomplete search runs still never replace complete membership;
- duplicate price-event behavior stays identical;
- lifecycle reopen/close history stays identical;
- statement count grows approximately **O(1) per batch/category**, not **O(N) per row**.

---

## P1 — Bulk price-history inserts

**File:** `scraper/src/price-history.js`  
**Function:** `recordPriceEvents()`

The function does useful work before insertion:

- normalizes candidates;
- locks/loads relevant parent state;
- loads matching existing effective timestamps;
- classifies duplicate/conflicting/new events.

That logic can stay.

The final insertion phase currently writes each `insertedEvent` with an awaited query in a loop. Replace only that final phase with one set-based insert.

Conceptually:

```js
const payload = insertedEvents.map((event) => ({
  articleId: event.articleId,
  price: event.price,
  ppm2: event.ppm2,
  effectiveAt: event.effectiveAt,
  source: event.source,
  ingestedAt: event.ingestedAt,
}));

await client.query(BULK_INSERT_PRICE_EVENTS_SQL, [JSON.stringify(payload)]);
```

This is a low-risk performance refactor because the conflict-classification semantics can remain exactly where they are.

### Small cleanup in the same file

`dayInBanjaLuka()` creates an `Intl.DateTimeFormat` repeatedly. Hoist the formatter:

```js
const BANJA_LUKA_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Sarajevo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
```

This will not materially move end-to-end performance compared with bulk SQL, but it removes needless object creation and makes the timezone policy more visible.

---

## P2 — Bulk detail archival and success/failure completion writes

**Files:** `scraper/src/db.js`, `scraper/src/scraper.js`

The detail flow is already bounded to a small number of jobs, so this is not as urgent as search ingestion.

Still, there are two avoidable patterns:

1. detail raw responses are archived one-by-one before the existing bulk listing update;
2. successful job outcomes are finalized with one database call per result.

Add batch methods such as:

```js
db.archiveDetailResponses(responses)
db.completeDetailJobs(outcomes)
```

and retain the existing single-item methods as wrappers only if tests/callers benefit from them.

This reduces query count and, more importantly, makes the enrichment orchestration shorter.

---

## P2 — Fix the ambiguity in detail batch pacing

**File:** `scraper/src/api.js`  
**Function:** `fetchDetailsInBatches()`

The current structure is effectively:

```js
for (each batch) {
  await Promise.all(
    batch.map(async (...) => {
      await sleep(delayMs);
      return fetch(...);
    })
  );
}
```

Every request in a batch sleeps concurrently and then starts at approximately the same time.

If `GEO_DELAY_MS` means **“gap between batches”**, make that directly visible:

```js
for (let i = 0; i < ids.length; i += concurrency) {
  if (i > 0 && delayMs > 0) {
    await sleep(delayMs);
  }

  const batch = ids.slice(i, i + concurrency);
  const results = await Promise.all(batch.map(fetchOne));
  // ...
}
```

Benefits:

- no unnecessary delay before the first batch;
- the code matches the configuration comment;
- the actual concurrency behavior is obvious.

If the intended policy is instead **“space individual outbound requests”**, use a worker/semaphore or stagger each request. Do not use identical sleeps inside `Promise.all`, because that does not space the requests.

Add a fake-clock/fake-sleep unit test so the intended semantics cannot drift again.

---

## P2 — Centralize API rate-limit state

**Files:** `scraper/src/scraper.js`, `scraper/src/api.js`

The scraper currently reacts to low remaining quota after responses are already in flight. With a concurrent pagination wave, a response that discovers low remaining capacity cannot “unsend” its sibling requests.

This is not necessarily a production problem at the current low concurrency, but the ownership is hard to reason about.

Introduce one small rate controller in the request layer:

```js
class RateBudget {
  observe(headers) {}
  async beforeRequest() {}
  async onRateLimited(retryAfterMs) {}
}
```

The important design change is not the class itself. It is that **all API requests consult the same budget before starting**.

Possible policy:

- honor `Retry-After` on 429;
- keep the configured reserve;
- when remaining quota reaches the reserve, block new starts;
- expose rate information in logs/health state;
- keep concurrency bounded independently.

Also replace the hard-coded `65000` cooldown with either:

- server-provided reset information when available; or
- a named configuration value such as `RATE_LIMIT_COOLDOWN_MS`.

---

## P2 — Profile `enrichmentQueue()` before adding an index

**File:** `scraper/src/db.js`  
**Function:** `enrichmentQueue()`  
**Indexes:** `db/init/01-indexes.sql`

The queue checks whether a listing has price evidence newer than `details_fetched_at`, excluding detail-sourced events.

The current price-event indexes are useful, but none is an obvious perfect match for:

```sql
article_id = ...
AND source <> 'detail'
AND ingested_at > details_fetched_at
```

If `EXPLAIN (ANALYZE, BUFFERS)` shows this subquery becoming expensive at production-like history volume, test a partial index such as:

```sql
CREATE INDEX CONCURRENTLY listing_price_events_non_detail_ingested_idx
ON listing_price_events (article_id, ingested_at DESC)
WHERE source <> 'detail';
```

Do **not** add it blindly. Every price event would then pay the index-write cost.

### Decision rule

Add the index only if:

- the enrichment-queue query is measurably expensive;
- the planner uses the index on realistic cardinality;
- the read benefit outweighs the write/storage cost.

---

## P3 — Consider moving maintenance out of the scrape cycle

**File:** `scraper/src/index.js`

A successful cycle also runs operations such as analytics rebuilding and raw-response retention cleanup. The project already has a separate maintenance service/profile.

If scrape latency becomes important, consider making scheduled scraper cycles responsible only for:

```text
fetch → ingest → enrich → lifecycle close
```

and run heavier maintenance on its own schedule.

This is workload-dependent. Keeping the current behavior may be preferable while the dataset is small because it gives stronger “fresh after every cycle” semantics.

A clean compromise is a config switch:

```text
RUN_MAINTENANCE_AFTER_SCRAPE=true|false
```

with the current behavior remaining the default initially.

---

# 3. Readability and maintainability

## P1 — Split `scraper/src/db.js` by responsibility

`db.js` is approximately 1,400 lines and owns too many unrelated concepts:

- connections / startup waits;
- migrations / locks;
- scrape runs;
- raw-response archival;
- current search ingestion;
- listing lifecycle;
- price/history integration;
- analytics rebuild;
- retention;
- detail queue/job leasing;
- detail enrichment writes.

The problem is not the line count by itself. It is that a change to one domain requires mentally loading several other domains and their invariants.

### Suggested target structure

```text
scraper/src/db/
  pool.js
  runs.js
  raw-responses.js
  ingestion.js
  lifecycle.js
  enrichment.js
  analytics.js
```

`price-history.js` can remain separate or move under the same directory later.

### Avoid a big-bang migration

Keep `Db` as a compatibility facade during the refactor:

```js
class Db {
  constructor(connectionString) {
    this.pool = createPool(connectionString);
    this.ingestion = createIngestionStore(this.pool);
    this.enrichment = createEnrichmentStore(this.pool);
    this.runs = createRunStore(this.pool);
  }

  commitSearchIngestion(...args) {
    return this.ingestion.commitSearchIngestion(...args);
  }

  claimDetailJobs(...args) {
    return this.enrichment.claimDetailJobs(...args);
  }
}
```

This lets you split one responsibility per PR while keeping the rest of the application and tests stable.

### Rule of thumb

The outer `Db` object should eventually contain:

- wiring;
- connection lifecycle;
- compatibility delegation.

It should not contain large SQL implementations.

---

## P1 — Make `scrapeSearch()` an orchestrator, not the whole workflow

**File:** `scraper/src/scraper.js`

`scrapeSearch()` currently coordinates most of the application:

- search validation;
- run creation;
- page fetching;
- raw-response archival;
- parsing;
- deduplication;
- pagination;
- rate-limit state;
- manifest creation;
- atomic DB commit;
- detail candidate selection;
- job claiming;
- detail fetching;
- detail persistence;
- outcome accounting;
- logging;
- failure finalization.

A top-level workflow is much easier to audit when it reads like the architecture document.

### Suggested shape

```js
async function scrapeSearch(ctx, searchUrl) {
  const run = await beginSearchRun(ctx, searchUrl);

  try {
    const harvest = await harvestSearchPages(ctx, run);
    const commit = await commitHarvest(ctx, run, harvest);
    const enrichment = await enrichHarvest(ctx, run, commit);

    return await finishSearchRun(ctx, run, {
      harvest,
      commit,
      enrichment,
    });
  } catch (error) {
    await failSearchRun(ctx, run, error);
    throw error;
  }
}
```

Possible modules:

```text
scraper/src/search/
  harvest.js
  commit.js
  enrichment.js
  outcomes.js
```

Keep the data passed between phases explicit. That makes it obvious which state belongs to harvesting versus persistence versus enrichment.

---

## P2 — Prefer structured errors over message regexes

Some outcome classification in the scraper derives categories from error message text.

Error message text is for humans. It is a brittle application API.

Extend `ApiError` or the diagnostic object with a stable machine-readable field:

```js
new ApiError("Response exceeded body limit", {
  kind: "response_too_large",
  status: 200,
  retryable: false,
});
```

Then classify using:

```js
switch (error.kind) {
  case "http_404":
  case "invalid_schema":
  case "rate_limited":
  // ...
}
```

This gives you:

- safer metrics;
- clearer tests;
- freedom to improve human error messages without breaking behavior.

---

## P2 — Add lightweight type checking before considering TypeScript

A full TypeScript migration would create a lot of churn for a small CommonJS project.

A better intermediate step is:

```text
// @ts-check
```

plus JSDoc typedefs for the core shapes:

```js
/**
 * @typedef {Object} SearchCard
 * @property {string} articleId
 * @property {string} url
 * @property {number|null} price
 * @property {number|null} sqm
 * @property {number|null} ppm2
 */
```

Useful types:

- `Config`;
- `SearchCard`;
- `SearchHarvest`;
- `PriceEvent`;
- `DetailPayload`;
- `DetailJob`;
- `RunOutcome`.

Start on the newly extracted modules rather than converting the whole repository in one PR.

---

## P2 — Canonicalize search-query parameter ordering

**File:** `scraper/src/config.js` / search-key normalization path

Search-key normalization removes transient pagination/bookkeeping parameters, but equivalent URLs whose query parameters appear in a different order can still become different keys.

Example:

```text
?category=23&city=1
?city=1&category=23
```

If those are semantically identical, canonicalize them:

```js
url.searchParams.delete("page");
url.searchParams.sort();
```

Then serialize the key.

Add tests for:

- reordered parameters;
- repeated parameters;
- encoded values;
- pagination removal;
- distinct filters remaining distinct.

This prevents accidental duplicate logical searches and makes logs/database keys easier to compare.

---

## P2 — Remove stale references while splitting modules

There are several signs of historical naming surviving after later refactors.

Examples observed during this review:

- `docs/OPERATIONS.md` links to `REBUILD-PERFORMANCE.md`, but that file is not present in `docs/`;
- the same document references `INSTANCE-VERIFICATION.md`, which is also not present there;
- a `db.js` comment refers to `11-neighborhoods.sql` while the current baseline uses `02-neighborhoods.sql`;
- another comment refers to “Migration 17” even though the current schema is a squashed numbered baseline;
- the API module comment says `ApiError` remains module-internal while it is exported.

These are small individually, but they increase the chance that a future change follows obsolete instructions.

### Preferred comment style

Document **current invariants**, not historical implementation steps.

Less useful:

```js
// Added in migration 17...
```

Better:

```js
// Rebuild daily inventory after committed lifecycle changes so dashboard
// snapshots observe the same search-state boundary.
```

Version history belongs in Git.

---

## P2 — Add a Markdown link checker to CI

**File:** `.github/workflows/ci.yml`

The current CI is strong for code, tests, dashboards, and integration behavior. Documentation-only pushes are intentionally ignored by the main code workflow.

That makes a lightweight docs job useful.

Add a separate workflow/job that checks:

- local Markdown links;
- referenced files;
- optionally anchors/headings.

Run it when:

```text
docs/**
README.md
**/*.md
```

changes.

This would have caught the missing documentation targets above without forcing PostgreSQL integration tests to run for a typo fix.

---

## P3 — Simplify the syntax-check npm script

**File:** `scraper/package.json`

The syntax-check script is compact but hard to parse as configuration.

Options:

1. let ESLint remain the syntax/parser gate; or
2. move the custom recursive check into `scripts/check-syntax.js`.

Prefer readable executable code over a dense shell one-liner when the script has branching/path traversal logic.

This is low priority because the current script works.

---

## P3 — Use Docker Compose anchors sparingly

**File:** `docker-compose.yml`

The hardening is good, but several Node-based services repeat common settings such as:

- build context;
- `no-new-privileges`;
- dropped capabilities;
- read-only filesystem;
- tmpfs;
- PID limit;
- backend-network attachment.

A single restrained anchor can reduce drift:

```yaml
x-app-common: &app-common
  build:
    context: ./scraper
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  read_only: true
  pids_limit: 100
```

Do not try to make every service inherit a maze of anchors. Compose files become harder to debug when abstraction exceeds duplication.

---

# 4. Measurement and profiling

Do this **before and after** the P1 database changes.

## Add an opt-in ingestion benchmark

Suggested file:

```text
scraper/scripts/benchmark-ingestion.js
```

Scenarios:

```text
100 cards
500 cards
1,200 cards
```

For each scenario record:

- total `commitSearchIngestion()` duration;
- transaction duration;
- number of SQL statements;
- rows inserted/updated;
- price events inserted;
- duplicate/conflict count.

The most important metric for the bulk-write refactor is **statement/query count**, because wall-clock timing varies heavily by machine and storage.

### Desired result

Current shape:

```text
query count ≈ constant + O(cards)
```

Target shape:

```text
query count ≈ small constant number of bulk statements
```

Do not put a fragile millisecond threshold in CI.

---

## Optional query instrumentation

For development, either:

- wrap `pool.query` / `client.query` with a counter under `DEBUG_DB_QUERIES=1`; or
- enable `pg_stat_statements` in a profiling environment.

Useful outputs:

```text
query count by normalized statement
total execution time
mean execution time
rows
```

This will quickly distinguish “slow SQL” from “too many tiny SQL calls.”

---

## Profile these queries with real cardinality

Run:

```sql
EXPLAIN (ANALYZE, BUFFERS)
...
```

for:

1. `enrichmentQueue()`;
2. lifecycle closure queries;
3. daily inventory rebuild;
4. dashboard-heavy analytics queries.

Keep the plans in an optional local benchmark note rather than committing machine-specific timing as a universal expectation.

---

# 5. Tests to add around the refactor

The repository already has good integration coverage. Add targeted tests where new boundaries are introduced.

## Bulk ingestion regression tests

Assert identical results for:

- one listing;
- hundreds of listings;
- duplicate article IDs in one harvest;
- same price/effective timestamp replay;
- conflicting same-timestamp price evidence;
- reopened listing;
- incomplete pagination;
- membership replacement;
- failed transaction rollback.

If practical, add an instrumentation seam that asserts a bulk test does **not** execute one insert per card.

---

## Rate/pacing tests

Use injected sleep/fetch functions.

Test:

```text
first detail batch starts immediately
one delay occurs between batches
requests within a batch run concurrently
429 honors Retry-After
new requests stop when reserve policy blocks them
```

Avoid tests that actually sleep.

---

## Search-key normalization tests

Test equivalence of:

```text
?a=1&b=2
?b=2&a=1
```

while ensuring genuinely different filter sets stay distinct.

---

## Documentation CI test

At minimum, fail when a relative Markdown target does not exist.

---

# 6. Suggested implementation sequence

The sequence below minimizes the chance of mixing behavioral changes with structural changes.

## Phase 1 — Establish the baseline

- [ ] Add an opt-in ingestion benchmark.
- [ ] Add query-count instrumentation.
- [ ] Save baseline results for 100 / 500 / 1,200-card ingestions.
- [ ] Run `EXPLAIN (ANALYZE, BUFFERS)` for `enrichmentQueue()`.
- [ ] Fix broken/stale documentation references.
- [ ] Add Markdown-link CI.

**Goal:** know what is slow and remove obvious documentation drift before moving code.

---

## Phase 2 — Remove DB round-trips

- [ ] Bulk listing upserts.
- [ ] Bulk state-observation inserts.
- [ ] Bulk price-event inserts.
- [ ] Convert reopened-history inserts to a set-based operation if still row-by-row.
- [ ] Replace repeated membership checks such as `array.includes()` in larger loops with `Set` membership where applicable.
- [ ] Re-run integration tests.
- [ ] Re-run benchmark and compare query count.

**Goal:** preserve the exact transaction semantics while making ingestion set-based.

---

## Phase 3 — Split modules without changing behavior

- [ ] Extract DB run/raw-response functions.
- [ ] Extract DB ingestion functions.
- [ ] Extract DB enrichment functions.
- [ ] Extract DB analytics/maintenance functions.
- [ ] Keep the existing `Db` API as a facade.
- [ ] Extract search-page harvesting from `scrapeSearch()`.
- [ ] Extract enrichment orchestration.
- [ ] Reduce `scrapeSearch()` to high-level workflow steps.
- [ ] Add JSDoc typedefs / `// @ts-check` incrementally.

**Goal:** make invariants local and future optimization easier.

---

## Phase 4 — Improve request scheduling

- [ ] Clarify `GEO_DELAY_MS` semantics.
- [ ] Fix between-batch pacing.
- [ ] Add structured `ApiError.kind`.
- [ ] Move rate-budget ownership into the API/request layer.
- [ ] Replace the hard-coded low-quota cooldown.
- [ ] Add fake-clock request-pacing tests.

**Goal:** make outbound concurrency and rate behavior obvious from code.

---

## Phase 5 — Data-driven DB tuning

- [ ] Re-run `EXPLAIN` after realistic history growth.
- [ ] Test the partial non-detail price-event index.
- [ ] Keep it only if the planner and measured latency justify it.
- [ ] Profile daily rebuild before touching its SQL.
- [ ] Consider table partitioning only if retention tables become genuinely large.

**Goal:** avoid speculative indexes and premature database complexity.

---

# 7. PR-sized backlog

These are deliberately small enough to tackle independently.

```text
perf(db): bulk upsert listings during search ingestion
perf(db): bulk insert listing state observations
perf(price-history): bulk insert classified price events
perf(db): batch detail response archival and job completion
perf(db): replace linear membership checks with Set where useful

refactor(db): extract run and raw-response persistence
refactor(db): extract search ingestion store
refactor(db): extract enrichment store
refactor(db): extract analytics/maintenance store
refactor(db): keep Db as thin compatibility facade

refactor(scraper): extract page harvesting from scrapeSearch
refactor(scraper): extract detail enrichment workflow
refactor(api): centralize rate-budget handling
fix(api): make detail batch delay occur between batches
refactor(api): classify errors with stable machine-readable kinds

fix(config): canonicalize search key query parameter ordering

docs: repair stale and missing documentation references
ci: add markdown link validation
chore: replace historical migration-number comments with current invariants
chore: move syntax-check shell logic into a readable script

perf(db): benchmark enrichmentQueue and evaluate partial price-event index
perf: add repeatable ingestion/query-count benchmark
```

---

# 8. A possible end-state layout

This is a direction, not a requirement.

```text
scraper/
  src/
    api/
      client.js
      rate-budget.js
      errors.js

    search/
      harvest.js
      enrichment.js
      outcomes.js

    db/
      pool.js
      runs.js
      raw-responses.js
      ingestion.js
      lifecycle.js
      enrichment.js
      analytics.js

    parsing/
      search.js
      details.js
      normalization.js

    config.js
    index.js
    scraper.js        # thin high-level orchestration
    price-history.js  # or db/price-history.js

  scripts/
    check-syntax.js
    benchmark-ingestion.js
```

Do not reorganize every file at once. Move code only when there is a clear ownership boundary and a test protecting it.

---

# 9. Things I would *not* do yet

## Do not migrate wholesale to TypeScript

You can get most of the immediate readability benefit from JSDoc + `// @ts-check` with far less churn.

Revisit TypeScript only if the project gains:

- more contributors;
- more API/domain shapes;
- additional services;
- a public library interface.

## Do not add an ORM

The current SQL is domain-specific and uses PostgreSQL features intentionally. An ORM would likely obscure:

- advisory locks;
- `SKIP LOCKED`;
- set-based analytics;
- `unnest`;
- raw/evidence semantics.

Small SQL helper functions are a better fit.

## Do not add more scraper concurrency as a first performance fix

The likely dominant avoidable cost is local DB round-tripping, not lack of outbound parallelism. More request concurrency also makes rate-limit behavior harder.

## Do not partition tables yet

Bounded retention deletes plus useful indexes are already present. Partition only when table size, vacuum behavior, or retention duration demonstrates a need.

## Do not rewrite the daily rebuild first

It already contains explicit performance-oriented SQL. Measure it before changing it.

## Do not over-abstract Docker Compose

One small common anchor is enough. A deeply inherited Compose file is harder to operate than a little duplication.

---

# 10. Concrete success criteria

After the first major performance/refactor pass, I would consider the work successful if:

### Performance

- a 1,200-card ingestion no longer causes per-card listing/observation SQL statements;
- new price events are persisted in a bulk statement;
- detail job result persistence is batched where practical;
- benchmark output shows a dramatic reduction in database statement count;
- no scraper concurrency increase was required to get that improvement.

### Readability

- `scrapeSearch()` reads primarily as high-level workflow;
- `Db` is a thin facade rather than the implementation home of every database concern;
- individual DB modules each have a clear ownership domain;
- machine behavior never depends on matching human error-message text;
- configuration names describe actual pacing/rate semantics.

### Safety

- existing integration tests still pass unchanged;
- no incomplete search can replace current membership;
- advisory-lock boundaries remain intact;
- detail claims retain their lease / `SKIP LOCKED` behavior;
- raw-response evidence remains available;
- price-history duplicate/conflict semantics remain identical.

### Maintenance

- all internal Markdown links resolve;
- CI catches future broken doc links;
- comments describe current invariants rather than obsolete migration/file numbers;
- a repeatable performance harness exists for future changes.

---

# 11. Recommended first five PRs

If this were my backlog, I would start here:

### PR 1 — `perf: add ingestion query-count benchmark`

No behavior change. Establish a baseline and make later claims measurable.

### PR 2 — `perf(db): bulk search ingestion writes`

Bulk:

- listing upserts;
- state observations;
- reopen history where applicable.

Keep the same transaction and tests.

### PR 3 — `perf(price-history): bulk event persistence`

Keep classification logic; replace the insertion loop.

### PR 4 — `refactor(scraper): extract harvest and enrichment stages`

Behavior-preserving split. Make `scrapeSearch()` short enough that the full lifecycle can be reviewed on one screen.

### PR 5 — `refactor(db): split database responsibilities behind facade`

Move one domain at a time; do not change callers until the split is stable.

After those five, re-profile. The results will tell you whether rate limiting, detail batching, indexes, or analytics deserve the next round of work.

---

# 12. Files reviewed / especially relevant

```text
README.md
docker-compose.yml
.github/workflows/ci.yml
.github/workflows/security.yml

docs/ARCHITECTURE.md
docs/OPERATIONS.md
docs/METRIC-INVENTORY.md

scraper/package.json
scraper/src/index.js
scraper/src/config.js
scraper/src/api.js
scraper/src/scraper.js
scraper/src/db.js
scraper/src/parser.js
scraper/src/normalization.js
scraper/src/price-history.js
scraper/src/search-lifecycle.js

db/init/00-schema.sql
db/init/01-indexes.sql
db/init/06-rebuild.sql
```

---

## Bottom line

The repository's architecture is already better than the file sizes initially suggest. The important correctness boundaries are present.

The next step should therefore be **surgical**:

> preserve the transactional/lifecycle model, turn row-by-row persistence into set-based PostgreSQL operations, then make the orchestration code reflect the architecture that the project already documents.

That gives the highest probability of a substantial performance improvement **and** a codebase that is easier to extend later without introducing lifecycle bugs.
