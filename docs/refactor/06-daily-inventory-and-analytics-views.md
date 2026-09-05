# Daily inventory and analytics views

**Owner:** Historical reconstruction, daily inventory and reusable SQL analytics.  
**Dependencies:** Packages 01–05 in the [dependency index](00-contracts-and-dependencies.md#ownership-and-integration).  
**Shared rules:** [Contracts](00-contracts-and-dependencies.md).

## Daily inventory

Build `listing_daily` from timestamped state and canonical price evidence.

- Evaluate state immediately before the following Sarajevo midnight; use now for today.
- Include open tracked listings while their last sighting is within the existing 14-day freshness window.
- Carry inventory and prices through missed scrape days within that window, marking stale observations. Expiry is not a recorded closure.
- Use historical category membership and attributes; do not filter historical dates through current `search_results`.
- Include closed listings on the earlier days when they were active.
- Before reliable tracking, reconstruct continuous membership from the earliest valid history event using the agreed estimation policy. Known closure gaps override this assumption.
- Use later known area only for explicitly labelled historical estimates. Do not use future prices.
- Rebuild affected article/date ranges after historical imports; persist and retry failed rebuilds. Rebuild through today after scraper startup/cycle completion, including missed calendar days.

## Analytics interfaces

Expose:

- `v_listing_daily` for listing-level daily inventory and quality.
- `market_daily_filtered(...)` accepting date range and existing dashboard filters, returning inventory count, priced count, p25, median, p75, estimated count and stale count.
- `v_listing_price_changes` collapsing consecutive unchanged prices and comparing valid prices within the same deal type.
- Updated lifecycle and market-flow views that preserve reopenings and distinguish first price evidence from first tracked sighting.

Weekly comparisons use pooled eligible **listing-day rows**, not price-change rows or medians of daily medians.

## Acceptance criteria

- Three unchanged listings at 1,000, 2,000 and 9,000 KM/m² produce a 2,000 median every eligible day.
- Changing the middle listing to 3,000 produces a 3,000 median, regardless of scrape frequency.
- Test overlapping categories, closure/reopening, no-run days, 14-day expiry, null-price boundaries, imported old prices, inferred area and Sarajevo DST boundaries.
- Refresh reruns produce identical rows; a late import changes only affected historical ranges.
