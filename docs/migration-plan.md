# Migration Plan: Simplify pik-market-watch DB to a lean, low-row-count design

## Context for the executing agent

This is a real-estate scraper (`olx.ba`) with **a couple thousand active listings**.
The current production schema (`db/init/*.sql` in `JugoslavJ/pik-market-watch`) was
built for a much larger scale than the data actually reaches: it has a
simulated partitioning layer (table inheritance + a per-row routing trigger),
a separate `olap` schema that duplicates every mart via a refresh pipeline,
a content-addressed state-version dedup table, and a population-wide
self-join scoring view recomputed on most refresh cycles.

None of that machinery is wrong, and none of it is currently causing
measurable slowness — but at this row count it costs more in surface area,
migration risk, and maintenance than it returns in performance. The goal of
this migration is to replace it with a **flat, six-table OLTP schema**, sized
for a workload that will comfortably run in 1–10ms per query without any of
the current tiering. The lean schema has no derived score materialization.

**Do not carry over:** the `olap` schema, the partition-simulation objects
(`analytics_partition_policy`, `analytics_partition_registry`,
`ensure_analytics_partitions`, `route_analytics_partition_insert`, all
`*_YYYY_MM` child tables), `listing_state_versions` and its dedup machinery,
`append_only` mutation-prevention triggers, and the `reporting.*` scope
functions built for persona dashboards driven off `olap.current_listing_scores`.

**Do carry over:** the actual listing/price/search/run data, `neighborhoods`
(PostGIS boundaries), and Home, Overview, Health, and Exits dashboards. Agent,
Buyer, and Renter dashboards are removed from the lean rollout.

---

## Guardrails for every phase

- This is a small dataset. **Do not micro-optimize; do prioritize
  correctness of the data migration.** A full one-shot `INSERT ... SELECT`
  per table is fine — there is no need for batching, chunked backfills, or
  online schema-change tooling at this row count.
- Every phase must be able to run with the **old schema still present and
  the scraper still writing to it**, until Phase 6. Do not drop or rename
  any existing object before Phase 6.
- After every phase, run the validation queries listed for that phase before
  moving to the next one.
- Take a full `pg_dump` (`pg_dump -Fc`) immediately before Phase 1 and again
  immediately before Phase 6. Keep both.

---

## Phase 0 — Freeze and snapshot

1. Stop the scraper service (`docker compose stop scraper`, or equivalent) so
   no writes land mid-migration. The DB container stays up.
2. Take a full logical backup:
   ```bash
   docker compose exec db pg_dump -U olx -Fc olx > pre-migration-$(date +%Y%m%d).dump
   ```
3. Record current row counts for every table you're about to touch, for
   later reconciliation:
   ```sql
   SELECT 'listings' t, count(*) FROM public.listings
   UNION ALL SELECT 'listing_price_events', count(*) FROM public.listing_price_events
   UNION ALL SELECT 'saved_searches', count(*) FROM public.saved_searches
   UNION ALL SELECT 'search_results', count(*) FROM public.search_results
   UNION ALL SELECT 'scrape_runs', count(*) FROM public.scrape_runs
   UNION ALL SELECT 'neighborhoods', count(*) FROM public.neighborhoods;
   ```
   Save this output — Phase 2's validation compares against it.

**Validation:** scraper process confirmed stopped; dump file exists and is
non-zero size; row-count snapshot saved.

---

## Phase 1 — Create the new schema alongside the old one

Create a new schema, `lean`, so the new tables live side by side with the
existing `public`/`olap`/`reporting` schemas with zero collision risk.

```sql
CREATE SCHEMA lean;

CREATE TABLE lean.neighborhoods (
    name     text PRIMARY KEY,
    boundary geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX neighborhoods_boundary_gist ON lean.neighborhoods USING gist (boundary);

CREATE TABLE lean.saved_searches (
    search_key      text PRIMARY KEY,
    name            text NOT NULL,
    url             text NOT NULL,
    category        text,
    last_scraped_at timestamptz,
    listing_count   integer,
    median_ppm2     integer
);

CREATE TABLE lean.listings (
    article_id      bigint PRIMARY KEY,
    url             text NOT NULL,
    title           text NOT NULL,
    deal            text NOT NULL CHECK (deal IN ('sale','rent')),
    property_type   text,
    sqm             numeric(8,2),
    rooms           text,
    price           numeric(12,2),
    currency        text NOT NULL DEFAULT 'BAM',
    ppm2            integer,
    neighborhood    text REFERENCES lean.neighborhoods(name),
    latitude        double precision,
    longitude       double precision,
    seller_type     text,
    condition       text,
    parking         boolean,
    elevator        boolean,
    floor_num       smallint,
    year_built      smallint,
    extra           jsonb NOT NULL DEFAULT '{}',
    search_keys     text[] NOT NULL DEFAULT '{}',
    first_seen      timestamptz NOT NULL DEFAULT now(),
    last_seen       timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz,
    closing_price   numeric(12,2)
);
CREATE INDEX listings_active_filter_idx
    ON lean.listings (deal, property_type, neighborhood, rooms) WHERE closed_at IS NULL;
CREATE INDEX listings_price_idx ON lean.listings (deal, price) WHERE closed_at IS NULL;
CREATE INDEX listings_geo_idx ON lean.listings (latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX listings_search_keys_idx ON lean.listings USING gin (search_keys);

CREATE TABLE lean.price_history (
    id          bigserial PRIMARY KEY,
    article_id  bigint NOT NULL REFERENCES lean.listings(article_id),
    observed_at timestamptz NOT NULL DEFAULT now(),
    price       numeric(12,2),
    currency    text NOT NULL DEFAULT 'BAM',
    source      text NOT NULL DEFAULT 'search'
);
CREATE INDEX price_history_article_idx ON lean.price_history (article_id, observed_at DESC);

CREATE TABLE lean.scrape_runs (
    id           bigserial PRIMARY KEY,
    search_key   text REFERENCES lean.saved_searches(search_key),
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    pages        integer,
    cards        integer,
    status       text NOT NULL DEFAULT 'running',
    error        text
);

-- Keep closure cycles after a listing reopens. This is intentionally narrower
-- than historical attribute or daily-state reconstruction.
CREATE TABLE lean.listing_lifecycle_events (
    id              bigserial PRIMARY KEY,
    article_id      bigint NOT NULL REFERENCES lean.listings(article_id),
    event_type      text NOT NULL CHECK (event_type IN ('closed', 'reopened')),
    occurred_at     timestamptz NOT NULL,
    opened_at       timestamptz,
    price           numeric(12,2),
    deal            text,
    property_type   text,
    neighborhood    text,
    sqm             numeric(8,2),
    rooms           text,
    latitude        double precision,
    longitude       double precision,
    title           text,
    url             text,
    UNIQUE (article_id, event_type, occurred_at)
);
CREATE INDEX lifecycle_events_closed_idx
    ON lean.listing_lifecycle_events (occurred_at DESC, deal, property_type, neighborhood)
    WHERE event_type = 'closed';

```

**Validation:** `\dt lean.*` shows six tables and no materialized views; no errors;
old schemas untouched (`\dt public.*` still shows the full original set).

---

## Phase 2 — Backfill data from the old schema into `lean`

Run in this order (respects FKs: neighborhoods → saved_searches → listings →
price_history / scrape_runs).

After `02-lean-backfill.sql` and the count reconciliation in
`03-lean-validate.sql`, run `04-lean-lifecycle-events.sql` while the old
reporting lifecycle source and `public.listings` still exist. It copies past
close/reopen cycles into `lean.listing_lifecycle_events`, then captures any
closure state accumulated in lean since the first backfill. Run it with the
scraper stopped before enabling the event-writing lean writer. The migration
is idempotent. Reopens recorded by the initial lean one-shot before this table
existed use `lean.listings.last_seen` as their estimated reopen time.

If the old `public` writer completed more runs after the initial backfill,
stop it and apply `06-lean-public-catch-up.sql` before dashboard cutover. This
repeatable-read reconciliation refreshes lean's current listing/search state,
copies newer completed runs, and appends missing valid price and lifecycle
events. It does not restore the retired daily, attribute-change, or past
search-membership histories. Rerunning it is safe.

```sql
-- Neighborhoods: straight copy of the canonical boundary.
INSERT INTO lean.neighborhoods (name, boundary)
SELECT name, boundary FROM public.neighborhoods;

-- Saved searches: straight copy.
INSERT INTO lean.saved_searches (search_key, name, url, category, last_scraped_at, listing_count, median_ppm2)
SELECT search_key, name, url, category, last_scraped_at, listing_count, median_ppm2
  FROM public.saved_searches;

-- Listings: column mapping from public.listings, with derived fields.
-- `deal` derives from is_rent. Type and neighborhood are classified directly
-- from the retained source helpers; lean stores no benchmark or score rows.
INSERT INTO lean.listings (
    article_id, url, title, deal, property_type, sqm, rooms, price, currency,
    ppm2, neighborhood, latitude, longitude, seller_type, condition, parking,
    elevator, floor_num, year_built, extra, search_keys, first_seen, last_seen,
    closed_at, closing_price
)
SELECT
    l.article_id, l.url, l.title,
    CASE WHEN l.is_rent THEN 'rent' ELSE 'sale' END AS deal,
    reporting.comparison_property_type(l.article_id),
    l.sqm, l.rooms, l.price, 'BAM',
    l.ppm2, public.neighborhood_of(l.latitude,l.longitude), l.latitude, l.longitude,
    l.seller_type, l.condition, l.parking, l.elevator, l.floor_num, l.year_built,
    jsonb_strip_nulls(jsonb_build_object(
        'bathrooms', l.bathrooms, 'floors_total', l.floors_total,
        'unit_levels', l.unit_levels, 'heating', l.heating,
        'furnished', l.furnished, 'garage', l.garage,
        'plot_sqm', l.plot_sqm, 'orientation', l.orientation,
        'views', l.views, 'favorites', l.favorites,
        'rooms_detail', l.rooms_detail, 'characteristics', l.characteristics
    )),
    COALESCE(sk.search_keys, '{}'),
    l.first_seen, l.last_seen, l.closed_at, l.closing_price
FROM public.listings l
LEFT JOIN (
    SELECT article_id, array_agg(DISTINCT search_key) AS search_keys
      FROM public.search_results
     GROUP BY article_id
) sk ON sk.article_id = l.article_id;

-- Price history: canonical valid observations only, oldest evidence source
-- that carries an actual price. Adjust the `source` filter if your
-- price_state values differ from 'valid'.
INSERT INTO lean.price_history (article_id, observed_at, price, currency, source)
SELECT article_id, effective_at, price,
       COALESCE(currency, 'BAM'),
       CASE WHEN source IN ('search','detail') THEN source ELSE 'search' END
  FROM public.listing_price_events
 WHERE price_state = 'valid' AND price IS NOT NULL
 ORDER BY article_id, effective_at;

-- Scrape runs: straight copy (observability history, not load-bearing).
INSERT INTO lean.scrape_runs (id, search_key, started_at, finished_at, pages, cards, status, error)
SELECT id, search_key, started_at, finished_at, pages, cards, status, error
  FROM public.scrape_runs;
SELECT setval('lean.scrape_runs_id_seq', (SELECT max(id) FROM lean.scrape_runs));

```

**Validation — run all of these and confirm row counts are sane relative to
Phase 0's snapshot (price_history may legitimately be smaller than
`listing_price_events` since only `valid` rows are carried over):**

```sql
SELECT 'lean.listings' t, count(*) FROM lean.listings
UNION ALL SELECT 'lean.price_history', count(*) FROM lean.price_history
UNION ALL SELECT 'lean.saved_searches', count(*) FROM lean.saved_searches
UNION ALL SELECT 'lean.scrape_runs', count(*) FROM lean.scrape_runs
UNION ALL SELECT 'lean.neighborhoods', count(*) FROM lean.neighborhoods;

-- Spot-check: every listing has a valid deal value, no orphaned search_keys.
SELECT count(*) FROM lean.listings WHERE deal NOT IN ('sale','rent'); -- expect 0
SELECT count(*) FROM lean.listings l, unnest(l.search_keys) sk
  WHERE NOT EXISTS (SELECT 1 FROM lean.saved_searches ss WHERE ss.search_key = sk); -- expect 0

-- Spot-check a handful of individual listings by hand against public.listings
-- to confirm price/sqm/rooms/coords match exactly.
```

If `property_type`/`neighborhood` came back NULL for many rows because
their source was stale or unavailable, do not proceed to
Phase 3 until you've sourced those from wherever the app's classification
logic actually lives (check `scraper/src/parser.js` and
`scraper/src/normalization.js` for the category/neighborhood assignment
rules) and re-run the affected `UPDATE`s.

---

## Phase 3 — Point the scraper at the new schema

This is application code, not SQL — hand this to the coding agent working in
`scraper/src/`.

1. **`scraper/src/db.js`** — no change needed if it's just a connection
   pool; confirm it doesn't hardcode `search_path` to `public`.
2. **`scraper/src/db/ingestion.js`** — replace the `jsonb_to_recordset` bulk
   insert into `public.listings` with an upsert into `lean.listings`.
   Key behavior changes to implement:
   - Compute `deal` from the scraped rent/sale flag directly (`'rent'`/`'sale'`),
     not `is_rent` boolean.
   - Compute `property_type` and `neighborhood` inline in application code
     at ingestion time (this logic currently lives partly in SQL views —
     port it to JS or to a single SQL function called per-batch, not a
     population-wide view).
   - Maintain `search_keys` directly: on each search's ingestion, replace
     that search's key in the array for every article currently returned by
     it, and remove it for articles no longer returned. A single
     `array_remove`/`array_append` per affected row, no join table.
   - Insert into `lean.price_history` only when price actually changed
     (compare to the listing's current `price` before insert) — mirrors the
     old "append-only, changed-value-only" semantics without the event-type
     state machine.
   - Wrap the whole batch in one transaction, as before.
3. **`scraper/src/search/enrichment.js`** and
   **`scraper/src/db/enrichment.js`** — same schema swap: update
   `lean.listings` columns directly instead of `public.listings` +
   `listing_detail_versions`. Drop detail-version history entirely — this
   design keeps only current state plus `price_history`, not a full
   attribute-change log. If losing attribute-change history is not
   acceptable to the project owner, flag this back before proceeding — it
   is the one genuine feature reduction in this plan (see "What this
   migration gives up," below).
4. **`scraper/src/db/lifecycle.js`** — closure pass becomes: for each
   listing, if `search_keys` is now empty, set `closed_at = now()` and
   `closing_price = price` (only if not already closed), and append a
   `closed` event with the current cycle's open time and listing snapshot.
   When a closed listing reappears, append a `reopened` event in the same
   transaction that clears its current closure fields. The event rows remain
   available for Exits panels after later reopenings.
5. **`scraper/src/db/maintenance.js`** — keep the legacy raw archive cleanup
   for public mode during the staged rollout. Lean mode purges its direct JSONB
   archive after `07-lean-raw-archive.sql`; it does not compact shared JSON
   fragments or analyze OLAP partitions.
6. Update `scraper/test/integration/*` fixtures and assertions to match the
   new column names/table names. Run `npm test` and
   `npm run test:integration` until green against `lean.*`.

**Validation:** run one full manual scrape cycle
(`docker compose run --rm scraper node src/index.js --once`) against the
`lean` schema with the old schema left in place but not written to anymore.
Confirm:

- `lean.listings` row count moves sensibly (new/closed counts match what
  `scrape_runs`/logs report).
- `lean.price_history` gets new rows only for listings whose price actually
  changed.
- No errors in scraper logs referencing `public.*`/`olap.*` tables.

---

## Phase 4 — Rebuild Grafana dashboards against `lean`

Keep Home, Overview, Health, and Exits as direct queries against
`lean.listings`, `lean.price_history`, `lean.listing_lifecycle_events`, and
`lean.scrape_runs`. Remove Agent, Buyer, and Renter dashboards. The lean
database does not materialize neighborhood benchmarks or generate listing
scores; per-listing asking rate (`ppm2`) remains available as price per area.

Suggested mapping (adjust panel-by-panel, this is a starting point for the
agent doing the port, not a literal 1:1 spec):

| Old dashboard concept                                                     | New query target                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reporting.dashboard_listings` (unfiltered inventory)                     | `SELECT * FROM lean.listings WHERE closed_at IS NULL`                                                                                                                                                                   |
| `reporting.market_daily` / `daily_listing_facts_olap` (trend)             | Compute directly from `lean.price_history.price_date`, carrying each listing's latest detail-reported price forward in the query. No materialized view or daily snapshot table is needed.                               |
| `reporting.scrape_health`                                                 | `SELECT * FROM lean.scrape_runs ORDER BY started_at DESC LIMIT N`                                                                                                                                                       |
| `reporting.exit_economics` / `lifecycle_cycles` / `lifecycle_movements`   | Query `lean.listing_lifecycle_events` where `event_type='closed'`; each event stores its cycle open/close dates, closing price, and event-time listing dimensions. Current active inventory remains in `lean.listings`. |
| `reporting.price_changes` / `comparison_price_changes`                    | `SELECT * FROM lean.price_history WHERE article_id = ANY(...) ORDER BY price_date`                                                                                                                                      |
| `reporting.olap_health` / `olap_queue_health` / `analytics_refresh_state` | Delete these panels entirely — there is no OLAP refresh pipeline in this design, so there is nothing to report health on                                                                                                |

**Note on daily history:** the lean design does not store a reconstructed
inventory snapshot or materialized market trend. It stores the latest
source-reported price for each listing and calendar date as one `price_date`
row per listing and source. Grafana derives
daily price medians by carrying the latest detail-reported price forward in
the query, while `first_seen` uses the listing's publication date and closure
events retain their event dates. Scrape-run and enrichment retry clocks keep
timestamps because the scraper uses subday timing for recovery and scheduling.

**Validation:** open each rebuilt dashboard, confirm every panel renders
with data, and spot-check 2–3 numbers against the old dashboard's current
values (they should match closely — not exactly, since `lean` was backfilled
from a point-in-time snapshot and the old dashboards may have kept running
during the port).

---

## Phase 5 — Cutover

1. The owner approved proceeding without waiting for a scheduled scraper
   interval or several days of dashboard usage (2026-09-28). Phase 6 used
   live dashboard-query checks and the first post-cleanup scraper cycles as
   the immediate validation instead.
2. Update `grafana/provisioning/dashboards` to point at the new dashboard
   JSON files; remove/disable the old dashboard JSON files (don't delete
   yet — move to an `archive/` folder, delete only after Phase 6 is
   confirmed stable).
3. Use `db/init-lean/` as the lean-only fresh-install baseline. Do not overwrite
   already-applied `db/init/*.sql` files: the application migrator records
   checksums and rejects changed applied files. Keep the current baseline
   available to existing volumes until Phase 6. Apply Phase 6's
   `07-lean-raw-archive.sql` before switching the existing deployment's
   `DB_INIT_DIR` to `./db/init-lean`; this ensures the
   live schema satisfies the complete lean contract when the migrator adopts
   the new ledger entries. New volumes pointed at `db/init-lean/` receive
   PostGIS, all lean tables, neighborhood boundaries, the raw archive, and the
   lean-compatible runtime roles. The migrator recognizes this lean contract
   and adopts the initialized schema without replaying its DDL. The live
   database continues to use the additive forward migrations in
   `db/migrations/`.

**Validation:** the owner approved proceeding without waiting for a scheduled
scraper cycle or 3–5 days of dashboard usage (2026-09-28).

---

## Phase 6 — Decommission the old schema

The owner approved proceeding without the scheduled-cycle and 3–5-day wait
(2026-09-28). Take and verify a full dump before cleanup. The raw response
archive is operational evidence and remains part of the retained data.
`detail_jobs` is superseded by lean's listing-level enrichment retry fields;
its current rows are all succeeded.

Audit all FK targets and inherited children immediately before cleanup. The
old monthly history tables use inheritance emulation, not declarative
partitioning. Drop each child table explicitly before its parent; dropping
only the parent does not guarantee the child relations are removed.

Before cleanup, apply and validate `07-lean-raw-archive.sql` with all writers
stopped. It copies the logical
contents of `public.raw_api_responses` into `lean.raw_api_responses`, retaining
every decoded request/response body and diagnostic, and copies
`scrape_run_pages` with its keys. Lean stores JSONB bodies directly instead of
carrying over the legacy shared-fragment storage machinery. This keeps raw
payload replay and retention while removing the old interning functions and
tables. The new archive foreign keys target `lean.listings` and
`lean.scrape_runs`. The migration checks source IDs and full row contents
before commit. A live app-role smoke test confirmed raw archive writes target
`lean.raw_api_responses`.

Immediately before cleanup, reconcile the archive rows and verify that public
listing IDs and valid price events are present in lean. Then stop Grafana and
database writers and run the tested cleanup migration:

```powershell
Get-Content -Raw db/migrations/08-decommission-legacy-public.sql |
  docker compose exec -T db psql -U olx -d olx -X -v ON_ERROR_STOP=1
```

The migration removes `olap`, `reporting`, and all non-extension application
relations and routines from `public`, while preserving PostGIS objects and
`public.schema_migrations`. It checks archive parity and lean foreign keys
inside the cleanup transaction. It explicitly removes inherited monthly
children before their parents.

### Live Phase 6 result (2026-09-28)

- `07-lean-raw-archive.sql` copied 2,286 raw responses and 2,669 page manifests
  with exact row-content checks. App-role smoke tests wrote a raw response and
  malformed page manifest to the lean archive tables, then removed the test
  rows. Replay used `lean.raw_api_responses`.
- Before cleanup, public had 2,220 listings and lean had 2,221. No public
  listing ID, valid price event, or populated dashboard listing detail was
  missing from lean. Lean had one newer listing, three newer scrape runs, four
  newer closures, and 21 additional valid price events. Public's 1,229 older
  `last_seen` values and four lingering search memberships were stale; the
  fifth membership difference was the new lean listing.
- The strict pre-cutover `03-lean-validate.sql` count check no longer passes
  after lean begins accepting writes. Its mismatch report reflects these
  expected newer lean observations, not public-only dashboard data. One
  actionable exception was found: article `78916648` retained exact source
  location `Laus 2` but had been assigned to `Laus 1` by pin fallback. The row
  was corrected, and lean classification now prefers an exact known source
  neighborhood before pin fallback.
- All staged Home, Overview, Health, and Exits dashboard SQL passed against
  the live database before cleanup, on a disposable restored copy after
  cleanup, and again after the first post-cleanup scrape. Scraper runs 528–530
  completed successfully. Replay of response `4973` parsed 10 items with no
  rejections.
- The verified pre-cleanup dump is
  `backups/olx-pre-phase6-cleanup-20260928-1540.dump` (20,003,005 bytes,
  SHA-256 `C0D7B6907A70F2FD2EECA4BA6BD7F8D46E31516DF12F743E2D199D44F326884A`).
  The verified post-cleanup dump is
  `backups/olx-post-phase6-20260928-1625.dump` (5,075,032 bytes,
  SHA-256 `48D887C1EA3ABB516B46CAFEF48FF21207A8D1B82731BD3FA6784024589E61CC`).
  After the post-cleanup scrape, lean contains 2,231 listings, 1,002 closed
  listings, 2,315 raw responses, and 2,669 copied page manifests; database
  size is 58 MB.
- Compose and `.env.example` now default `DB_INIT_DIR` to `./db/init-lean`.
  The live permanent namespace inventory contains `lean`, `public`, `tiger`,
  and `topology`; `public` has no non-extension application relations left.

The final full dump is verified and recorded below. Keep the verified
pre-cleanup dump next to it for rollback.

Keep the application tables under `lean`; `public` remains available for
PostGIS and extension objects. Do not rename `lean` to `public`.

**Validation:** all staged lean Grafana query SQL must execute; the application
and Grafana must remain healthy after restart; `\dn` should show `lean` plus
PostgreSQL extension schemas. Compare storage footprint after cleanup with
Phase 0.

---

## Approved history reductions

- **Full attribute change history.** The old `listing_detail_versions` /
  `listing_state_history` kept a versioned log of every detail change
  (condition, floor, heating, etc.), not just price. The new design keeps
  only current state plus price history. If "what did this listing's
  condition/floor/etc. look like on date X" ever needs answering, this design
  can't answer it. The project owner approved retiring this history for the
  lean cutover.
- **Sparse-history day reconstruction** (`listing_daily`,
  `membership_inferred`/`attributes_inferred`/`stale_observation` flags).
  There is no equivalent "reconstruct what was true on any past day even
  with gaps in observation" capability. Only real observed events
  (`first_seen`, `price_history` rows, `closed_at`, and recorded lifecycle
  events) are queryable. Lean-only reopen times from before the lifecycle
  upgrade use `last_seen` as an approximation.
- **Multi-search membership history over time.** `search_keys` on
  `lean.listings` only tracks _current_ membership, not "was in search A on
  day N, dropped, rejoined." If that matters, `lean.price_history`-style
  append-only membership-change log would need to be added back
  specifically for that, not for the whole schema.

Closure and reopen history is retained in the purpose-built
`lean.listing_lifecycle_events` table because the Exits dashboard uses it.
The owner approved retiring the three histories above during Phase 6.
