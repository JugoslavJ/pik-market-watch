# Real Estate Buyer dashboard

Status: proposed specification. This document does not implement dashboard, SQL,
scraper, or provisioning changes.

## Purpose

Help a buyer find homes within budget, compare asking prices across Banja Luka
neighbourhoods, and shortlist listings priced below comparable local listings.
The main journey is: set requirements, compare neighbourhoods, inspect interesting
listings, then open the original OLX ad.

Proposed dashboard title: **Find a home to buy**. Proposed UID: `olx-buyer`.
This is an interactive private dashboard using the private reporting surface.
Public publication is a separate future scope; existing public dashboards have
fixed filters and do not publish listing-value claims.

## Filters and defaults

| Filter | Behaviour |
|---|---|
| Property type | Single select; default apartments. Houses and vacation homes are separate populations. Configured search categories need a reliable property-type mapping before scoring. |
| Deal | Fixed to sale. |
| Neighbourhood | Multi-select; default all mapped neighbourhoods. Offer unknown-location listings separately. |
| Asking price, KM | Independently optional minimum and maximum; no default budget. |
| Asking price per m², KM/m² | Independently optional minimum and maximum. |
| Area, m² | Independently optional minimum and maximum. |
| Rooms | Multi-select using the existing room buckets. |
| Features | Optional condition, parking, garage, elevator, floor and seller type, where populated. Unknown is distinct from no. |
| Listing selection | All matches, first observed in the last 7 days, reduced in the last 30 days, or below local asking benchmark. |
| Minimum score | Optional 0–100 threshold; default unset. Unscored listings remain visible when unset. |
| History window | Default 30 days; optional 90 days. Controls historical panels and reduction badges, not current availability or benchmark membership. |

Numeric bounds are inclusive. Blank means unrestricted; malformed or negative
values and minimum greater than maximum produce a clear validation message.
A listing with an unknown required value does not satisfy that filter. With no
corresponding bound it remains visible with the value marked unknown. This is
stricter than the existing area-filter helper, which retains missing area.

## Layout

| Row | Panel | What the buyer sees |
|---|---|---|
| 1 | Search summary | Matching active listings, listings within the stated budget, scored matches below benchmark, and latest complete search freshness. Omit the budget count until a budget is set. |
| 2 | Prices by neighbourhood | Sortable table: neighbourhood, current listing count, eligible priced count, median asking KM/m², P25–P75 asking KM/m², median total asking price, within-budget count and scorable count. Total-price and per-m² samples are counted separately. |
| 2 | Neighbourhood price map | Neighbourhoods coloured by median asking KM/m², with sample size in tooltips. Selecting a neighbourhood narrows the listing results. A table provides the same information. |
| 3 | Interesting listings | Main ranked table with explicit reasons such as “12% below comparable local asks”, “first observed 2 days ago”, or “price reduced by 10,000 KM”. |
| 4 | Price versus area | Scatter plot of matching listings; area on x, asking price on y, colour by score, neutral colour for unscored rows. Each point opens its listing detail. |
| 4 | Neighbourhood asking-price trend | Daily median and P25–P75 KM/m² with sample counts, default last 30 days. Mark provisional and inferred history. |
| 5 | Listing detail | Selected ad, asking price, area, features, local benchmark, score explanation, comparable listings and valid price-change history. Link to OLX. |

Neighbourhood price statistics and trends use property type, rooms, area and
supported feature selections, before budget, per-m² price, recency and score
filters. Label these panels “Market context before price filters”. Show the
within-budget count alongside them. This lets buyers see an expensive
neighbourhood even when few of its listings fit the budget. Hide a neighbourhood
price statistic below 10 eligible distinct listings; retain its count.

The listing table contains title/link, neighbourhood, total asking KM, m²,
KM/m², rooms, local benchmark KM/m², deviation %, score, comparable count,
confidence, first observed, last seen, latest reduction and reason badges.
Default order: scored listings by descending score, then newest first observed,
then article ID; unscored matches follow. Also allow lowest total price, lowest
KM/m², newest and largest valid reduction. Show 25 rows per page.

## Shared listing-score contract, version 1

The [renter](DASHBOARD-RENTER.md) and [agent](DASHBOARD-AGENT.md) specifications
reuse this contract, with the renter's explicit rental-period and unit rules.
All thresholds here are proposed product defaults, not measured valuation accuracy.

### Population and comparable selection

1. Current means `closed_at IS NULL` and seen within the existing 14-day active
   window. Count distinct `article_id`; membership in multiple searches must not
   multiply a listing. Different ads for the same property remain a documented
   limitation until property-level deduplication exists.
2. Require resolved current valid, positive asking-price evidence, a verified
   common currency (KM/BAM), valid area and a mapped neighbourhood. Invalid,
   conflicting and unpriced boundaries must not fall back to an older valid price.
   Reuse applicable existing area and sale-price plausibility rules. A sale/rent
   switch starts a separate comparison series.
3. For each target, select other current listings in the same neighbourhood,
   property type, sale/rent segment and room bucket, with area within ±20% of the
   target. Exclude the target article itself. Missing room bucket or ambiguous
   property type means unscored. Do not broaden to another neighbourhood, property
   type or room bucket to obtain a score.
4. Use at least 10 eligible comparables after excluding the target. With 10–19,
   show “Limited sample”; with 20 or more, show “Larger sample”. These are coverage
   labels, not statistical confidence guarantees. Below 10, show “Insufficient
   comparables” and no numeric score.
5. Compute the benchmark before applying the user's budget, price-per-m² bounds,
   minimum score, recency or optional feature filters. Selecting which ads to see
   must not change the score of the same ad at the same observation time. Each
   target's own type, room bucket and area determine its comparison cohort.

Version 1 compares location, type, room bucket and size. It does not adjust for
condition, floor, furnishing, land size or renovation cost. Surface those facts
beside the score. Houses and vacation homes must show a prominent “Building-area
comparison; land and condition not adjusted” explanation; their scores must not
be ranked together with apartment scores.

### Calculation and interpretation

For a sale listing:

```text
listing_rate = current asking price / valid area
benchmark_rate = median(asking price / valid area of eligible comparables)
deviation_pct = 100 * (listing_rate / benchmark_rate - 1)
score = round(max(0, min(100, 50 - deviation_pct)))
indicative_total = benchmark_rate * listing area
asking_gap_km = current asking price - indicative_total
```

Use unrounded rates for calculations. Positive deviation means above the local
asking benchmark; negative means below. A score of 50 is at the benchmark, 70
means 20% below, and 30 means 20% above. Scores saturate at 0 and 100; always show
the actual deviation next to them. An unscored listing has a null score, never 0.

| Deviation | Label |
|---|---|
| Below −10% | Well below local asking benchmark |
| −10% to below −5% | Below local asking benchmark |
| −5% through +5% | Near local asking benchmark |
| Above +5% through +10% | Above local asking benchmark |
| Above +10% | Well above local asking benchmark |

Example: a 60 m² home asking 180,000 KM has a rate of 3,000 KM/m². If its
comparables have a median of 3,600 KM/m², deviation is −16.7%, score is 67, and
the indicative asking gap is −36,000 KM. These are illustrative values.

The visible label is **Local asking-price score**, with the explanation “Higher
means cheaper relative to comparable local asking prices.” This is a comparison
of tracked ads, not an appraisal, confirmed sale value or probability of a bargain.
Do not mix recency, reductions, views or feature completeness into this score;
show them as separate reasons to inspect a listing.

Each score explanation shows the benchmark timestamp, version, comparable count,
median, P25–P75 range, matching criteria and links to comparables. Missing area,
missing neighbourhood, invalid price and insufficient sample each have a specific
unscored reason. No citywide fallback is labelled a neighbourhood score.

## Data readiness and implementation boundaries

- `reporting.current_listings` supplies active listing attributes; it does not
  expose a resolved current `price_state`. A future reporting projection must
  resolve current price evidence using the canonical event precedence rules,
  expose score inputs and preserve invalid/conflict boundaries.
- `price_changes_filtered` supplies valid event-time changes. Interesting current
  reductions also require current availability, the same deal segment and a
  reduction that still applies to the current price. A later increase must not
  leave an obsolete “currently reduced” badge.
- `reporting.daily_listing_facts` supplies historical prices and quality flags.
  Recompute aggregates from each day's eligible population; do not apply today's
  scores to historical rows. Use `Europe/Sarajevo` calendar days.
- The latest per-category complete-search watermark can come from
  `dashboard_public.freshness`; unknown remains unknown. Display the oldest
  relevant search success and each ad's last seen time.
- Approximate pin-based neighbourhood assignment, sparse detail coverage and
  multiple ads for one home constrain comparisons. Missing map pins never remove
  otherwise matching listings from the table.
- Scoring, price filters, the comparable drilldown and any required reporting
  additions are future implementation work. Saved favourites and alerts are
  outside the first dashboard version.

## Acceptance criteria for future implementation

- A buyer can set a total budget, compare neighbourhood prices and open an
  interesting matching listing without visiting an operational dashboard.
- Setting or removing a budget changes matches and within-budget counts, while
  leaving market-context medians and a surviving listing's score unchanged.
- Known example inputs reproduce the formula, including positive/negative
  deviation, score clamping and threshold boundaries.
- The target never counts as its own comparable; 9 comparables produce no score,
  10 produce a limited-sample score, and overlapping searches produce one row.
- Missing required facts remain visible with an unscored reason when no filter
  requires them; stale or closed ads never appear as current opportunities.
- Every panel identifies its time basis, price units and eligible sample, and
  each listing links to its source and a readable score explanation.
