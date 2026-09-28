# Lean schema rollout and Phase 6 cleanup

The [Phase 6 execution record](STATUS-2026-09-28.md) records the live cleanup
and its backups. The [earlier rollout record](STATUS-2026-09-27.md) contains
the initial backup, backfill, and pre-cutover validation.

The numbered scripts are **manual one-time migration steps**, separate from
the checksum-managed `db/init-lean/` baseline. The rollout's Phase 6 cleanup
has now been applied to the live database.

1. Stop the scraper and any other database writer. Take and retain a full
   `pg_dump -Fc` of the database. Record the six source counts from
   `docs/migration-plan.md` Phase 0.
2. Run `01-lean-schema.sql` as the database migration owner. It creates six
   tables under `lean` and grants access to the
   existing `olx_app` and `olx_reporting` roles when present.
3. Run `02-lean-backfill.sql` as the same owner. It rejects nonempty targets,
   copies all rows in a repeatable-read transaction and resets identity
   sequences. A failed statement rolls back the
   entire copy.
4. Run `03-lean-validate.sql` **before** any writes to `lean`. Every value in
   its first result set must be zero. Compare the classification coverage and
   a handful of listing rows with the Phase 0 snapshot and source. Resolve
   any mismatch before the scraper cutover.
5. With the scraper stopped, run `04-lean-lifecycle-events.sql` after Phase 2
   and before the event-writing scraper code starts. For the already populated
   lean database, run this same additive script once during the upgrade. It is
   safe to rerun and requires the old `reporting.lifecycle_cycles_source` and
   `public.listings` to remain available.
6. For a lean schema created before score removal, run
   `05-lean-remove-score-generation.sql` as the database migration owner. It
   drops the derived `lean.neighborhood_stats` cache. Fresh schemas from the
   current `01-lean-schema.sql` do not create it, and the lean writer no longer
   refreshes it.
7. With every database writer stopped and a verified full backup available,
   run `07-lean-raw-archive.sql`. It copies all
   logical raw-response bodies and page manifests, verifies IDs and full row
   contents, and creates lean foreign keys. Then restart the lean scraper and
   maintenance job and verify capture, retention, and `replay-response.js`
   against the lean archive before dropping any public archive objects. This
   migration stores decoded JSONB directly in lean instead of keeping the old
   shared-fragment interning tables.
8. After validating the lean archive and dashboard queries, stop Grafana and
   writers and run `08-decommission-legacy-public.sql`. It checks listing,
   price-history, archive, and FK preconditions; removes OLAP/reporting and
   non-extension application objects from `public`; and preserves
   `public.schema_migrations` and PostgreSQL extension objects. This cleanup
   was applied on 2026-09-28 after a disposable-restore dry run.

`lean.listing_lifecycle_events` keeps each closure and reopen as a separate
row, keyed by article, event type, and event time. A closure row keeps its
cycle's `opened_at`, `occurred_at` closure time, final asking price when valid,
and event-time deal, type, neighborhood, size, and room values. Coordinates,
title, and URL are copied from the legacy current row during historical
backfill; the old source does not have location/title snapshots for each cycle.
The lean writer inserts future events with a snapshot in the same transaction
as its listing state change. The table is not pruned when a listing reopens.

The upgrade imports old cycles from the event-backed reporting source and
fills any missing old/current lean closures. The original lean writer did not
record a separate reopen event, so pre-upgrade lean-only reopens are inferred
from an old closed row and `lean.listings.last_seen`. That timestamp is an
approximation of the first reopened sighting if later sightings occurred.
The script cannot reconstruct a lean-only close/reopen cycle which finished
before it was run and is no longer visible in either current table. Run the
upgrade before resuming scheduled lean scrapes.

`01-lean-schema.sql` creates extra columns used by the current scraper:
`listings.price_text`, `published_at`, `renewed_at`, `details_fetched_at`,
`last_enrichment_attempted_at`, and `api_status`; `saved_searches.created_at`,
`new_count`, and `drop_count`; and `scrape_runs.is_complete`, `failure_reason`,
and `truncation_reason`. Other current-only listing attributes are retained in
`listings.extra`, including the latest price-state marker. Dashboard queries
that use the retained amount must check that marker before calling it a fresh
asking price.

The source `public.listings` table has no `currency` column. The copy uses the
latest valid price event matching its current price and normalizes `KM` to
`BAM`; otherwise it defaults to `BAM`. `lean.price_history` preserves every
valid non-null price event, its ID, evidence time, and original `source`.
`property_type` derives from the current search memberships via
`reporting.comparison_property_type`, with the recorded closing category used
for listings that have no current search membership; `neighborhood` follows the current
reporting rule using `public.neighborhood_of`. Unknown or ambiguous values
remain NULL and must be reviewed using the validation output.

Lean stores each listing's unit asking rate (`ppm2`) on the current listing
row. It does not materialize neighborhood benchmarks or generate listing
scores; those benchmarks only supported the removed persona dashboards.

The old source schema remains under `db/init/` for restore and migration-test
use, but it is no longer the Compose default. The live database retains
`public.schema_migrations` and extension objects in `public`; OLTP, raw
archive, and dashboard data live under `lean`.
