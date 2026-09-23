# Stage 5 — Historical filtering on physical OLAP facts

`public.market_daily_filtered()` now reads `olap.daily_listing_facts` directly.
The `reporting.market_daily_filtered()` API and its columns/arguments remain
unchanged. Its category membership, nullable area, raw/bucket room, deal,
neighborhood/location, valid-price, inferred, stale, and provisional-day
conditions retain their previous expressions.

The physical grain now stores `category`, `category_memberships`, `rooms`,
`sqm`, `location`, `membership_inferred`, `attributes_inferred`,
`stale_observation`, and `provisional_day`. Full publication and dirty-day
reconciliation both read `reporting.daily_listing_facts_source`; that source
now includes the added columns in physical-table order. Existing rows were
backfilled from `reporting.daily_listing_facts_source_canonical` rather than
from current listing state. The OLAP source validator reports 127,513 source
rows, 127,513 physical rows, zero missing rows, and zero unexpected rows.

The overview and home weekly sale panels and the exits daily priced-share panel
now use `reporting.daily_listing_facts_olap`, a narrow reporting view over the
physical facts. This keeps Grafana's read-only role out of the `olap` schema;
the role has SELECT on this view and still has no `olap` schema access. The
overview's main historical series and the exits inventory series continue to
use the existing reporting function API.

## Historical plans

Plans were run on the local PostgreSQL 18 database with
`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, SUMMARY)`, default dashboard filters,
inclusive Banja Luka-local dates, and warm shared buffers. The direct
`public` SQL function plans are saved in the before/after files below. Before
plans expand to the old reporting view and show the joins to daily history and
physical fact partitions. After plans scan the physical daily fact partitions
only. The exact Grafana reporting-wrapper plans are also saved; as expected,
the security-definer wrapper appears as a `Function Scan`.

| Query                      | Output rows | Before exec / shared hits | After exec / shared hits |       Change |
| -------------------------- | ----------: | ------------------------: | -----------------------: | -----------: |
| 30 days, expanded function |          31 |       149.358 ms / 46,564 |        24.418 ms / 1,866 | 83.7% faster |
| 90 days, expanded function |          91 |       194.960 ms / 58,581 |        37.286 ms / 2,777 | 80.9% faster |
| 30 days, Grafana wrapper   |          31 |       128.696 ms / 58,239 |        39.380 ms / 7,530 | 69.4% faster |
| 90 days, Grafana wrapper   |          91 |       150.891 ms / 70,290 |        44.738 ms / 8,487 | 70.4% faster |

The settings were unchanged: `effective_cache_size=1536MB`, `work_mem=8MB`,
`random_page_cost=1.1`, and `effective_io_concurrency=200`. No indexes were
added. The physical scan uses the existing day/article grain indexes; index
selection remains Stage 6 work. Planning-buffer hits for the expanded plans
were 12,833/7,186 before/after; planning time was 25.511/12.963 ms (30d) and
24.837/15.640 ms (90d).

Full plans:

- 30d expanded: [before](performance-stage5-before-30d.plan) · [after](performance-stage5-after-30d.plan)
- 90d expanded: [before](performance-stage5-before-90d.plan) · [after](performance-stage5-after-90d.plan)
- 30d Grafana wrapper: [before](performance-stage5-before-30d-grafana.plan) · [after](performance-stage5-after-30d-grafana.plan)
- 90d Grafana wrapper: [before](performance-stage5-before-90d-grafana.plan) · [after](performance-stage5-after-90d-grafana.plan)

## Correctness comparison

[`performance-stage5-correctness.sql`](performance-stage5-correctness.sql)
compares the old aggregate over `reporting.daily_listing_facts` with the
existing reporting function over 10 cases: all filters at 30 and 90 days,
category, min area, max area, area range, room bucket, deal, neighborhood, and
combined category/area/room/deal/neighborhood. Results compare every output
column per day. It returned 781 rows on each side and zero mismatches. A
physical fact/reporting-view comparison over all history also returned zero
differences for every field used by the function and migrated panels. The
separate published-source validator returned zero missing or unexpected rows
after the backfill.

## Remaining enriched reporting reads

Historical buyer, agent, and renter feature panels still query
`reporting.daily_listing_facts`. Those panels use raw historical attribute
JSON (for example parking, garage, elevator, heating, and floor values) and
the enriched historical quality fields. The physical table has selected
normalized historical attributes, but not the full raw attribute payload, so
the reporting view's join to `public.listing_daily_state` remains necessary
for those contracts. The view also exposes current title/URL from
`public.listings`; PostgreSQL can prune that join in consumers that do not use
those columns. The exits filter option queries continue to combine historical
values with saved-search and current-dashboard values. The optimized trend
and inventory queries no longer incur the operational-history join.
