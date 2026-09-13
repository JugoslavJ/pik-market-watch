# Real Estate Agent dashboard

Status: proposed specification. This document does not implement dashboard, SQL,
scraper, or provisioning changes.

## Purpose

Help an agent compare neighbourhood asking prices, inspect competing listings,
prepare a comparable-listing discussion and identify ads whose pricing or recent
changes merit review. The workflow is: select a market segment, compare local
inventory, select a listing, then inspect its evidence and comparables.

Proposed dashboard title: **Agent market desk**. Proposed UID: `olx-agent`.
This is an interactive private dashboard. It describes the tracked OLX inventory;
it does not assume access to an agent's portfolio, CRM or completed transactions.

## Filters and defaults

| Filter | Behaviour |
|---|---|
| Deal | Single select sale or rent; default sale. All price panels and units switch together. |
| Property type | Single select; default apartments. Never pool apartment, house and vacation-home price benchmarks. |
| Neighbourhood | Multi-select; default all mapped neighbourhoods. Unknown location is a separate browsable group. |
| Asking-price bounds | Optional minimum/maximum KM for sale; KM/month for rent. All rental prices are monthly under the confirmed dataset rule. |
| Price-per-m² bounds | Optional KM/m² for sale or KM/m²/month for rent. |
| Area and rooms | Optional independent area bounds and room buckets. |
| Features and seller type | Optional known condition, furnishing, parking and seller type. `private`/`shop` describes source seller type, not ownership by this agent or a verified brokerage. |
| Pricing position | All, below, near, above local asking benchmark, or unscored. Use the shared deviation thresholds. |
| Score bounds | Optional minimum/maximum 0–100; default unset. Useful for inspecting either end of the pricing distribution. |
| Review signals | First observed in 7 days, valid reduction in 30 days, or observed current cycle at least 60 days old. |
| Analysis window | Default 30 days; optional 90 days for historical trends, events and exits. |
| Subject listing | Optional article ID selected from current results for the comparable-listing detail. |

Use inclusive numeric bounds, blank for no restriction and visible invalid-range
messages. Missing facts do not satisfy an active bound. Sale and rent populations
remain separate even when navigating from a listing or another dashboard.

## Layout

| Row | Panel | What the agent sees |
|---|---|---|
| 1 | Market summary | Matching active ads, eligible priced/scored counts, median asking rate, valid reductions in the analysis window and observation freshness. Each count identifies whether it measures current ads or events. |
| 2 | Neighbourhood pricing matrix | Neighbourhood, active count, priced sample, median/P25/P75 asking rate, median total asking price, within-price-range count, below/near/above benchmark counts and unscored count. |
| 2 | Neighbourhood map | Colour by median asking rate for the selected deal/type; tooltip gives units and eligible sample. Click through to local listings. |
| 3 | Listings to review | Sortable current-ad table with score, deviation, sample size and independent review reasons. |
| 4 | Subject and comparables | Selected listing next to its exact scoring cohort, median, P25–P75, implied total asking range and observed asking gap. |
| 4 | Price versus observed age | Scatter plot of current-cycle age against deviation; distinguish reduced, unreduced and unscored ads. |
| 5 | Asking-price trend | Daily neighbourhood asking-rate medians and spreads, with priced samples and evidence-quality flags. |
| 5 | Supply movement | First observations, reopenings and observed closure cycles over the selected window, separated by neighbourhood and deal/type. |
| 6 | Observed exits | Closure-cycle counts, median observed cycle duration and median final observed asking price with separate eligible samples. Link to the existing Exits dashboard for detail. |

Neighbourhood price statistics and trends use type, rooms, area and supported
feature selections before asking-price, score and review-signal filters. Label
them “Market context before price filters”. Their within-price-range and pricing-
position counts describe matching current results and must be labelled separately.
Suppress neighbourhood price aggregates below 10 eligible listings, but keep
counts visible. Rental panels use the confirmed monthly price basis from the
renter spec. Benchmark distributions and total-price statistics have separate samples.

The review table includes title/OLX link, neighbourhood, deal/type, asking price,
area, asking rate, local benchmark, deviation %, score, comparable count,
confidence, seller type, first observed, current-cycle age, last seen, latest
valid reduction and reason badges. Show 25 rows per page and these selectable views:

| View | Selection and default order |
|---|---|
| Below local asks | Deviation below −5%, highest score first. |
| Above local asks | Deviation above +5%, largest positive deviation first. |
| Long-observed and above local asks | Current observed cycle at least 60 days old and deviation above +5%; greatest age first. This is a review signal, not proof that a home cannot sell. |
| Recent reductions | Currently applicable, same-segment valid reductions in the selected window; largest percentage reduction first. |
| New competition | First observed in the last 7 days; most recent first. Reopened ads carry a separate badge. |
| Needs more evidence | Unscored matches with their missing-data or insufficient-sample reason; newest first. |

Use article ID as a stable final sorting key. Default to the “Below local asks”
view and make all views directly accessible; the dashboard must support both
finding lower-priced inventory and discussing ads priced above local asks.

## Scores and comparable-listing discussion

Use exactly the [shared version 1 score](DASHBOARD-BUYER.md#shared-listing-score-contract-version-1)
for sale listings and the [rental score rules](DASHBOARD-RENTER.md#rental-score)
for rentals. The same listing at the same evaluation time must have the same
score in the buyer/renter and agent dashboards. Higher always means cheaper
relative to local comparable asking prices; it does not mean a better client lead.

The subject detail presents:

- Current asking price and rate, local median and P25–P75 rate, deviation and
  score, coverage label, evaluation timestamp and formula version.
- Every eligible comparable with source link, area, rooms, asking price, rate
  and last observation. Exclude the subject and deduplicate by article ID.
- Indicative total asking range `P25 rate × subject area` through
  `P75 rate × subject area`, plus median-based total and the current asking gap.
  Label this as a spread of comparable asks, not a sale-price prediction or
  statistical confidence interval.
- Matching criteria and omitted factors such as condition, floor, land and
  renovation. Rental detail also shows monthly units and furnishing.
- Current-cycle asking-price changes with effective event dates. Do not join
  changes across invalid evidence or sale/rent boundaries.

Price-range filters select review candidates, not the subject's comparable cohort.
If the subject has fewer than 10 eligible comparables, list available evidence
and the unscored reason but withhold the numeric benchmark-derived score and
indicative range. Do not invent a broader-neighbourhood valuation.

## Time and interpretation rules

Current inventory, current scores and market-context price statistics are evaluated
now using the 14-day observation rule. Historical trends use reconstructed daily
facts in `Europe/Sarajevo`, with provisional, inferred and stale flags visible.
Price changes use event effective time. Supply movement and exits use observed
lifecycle boundaries, with attributes resolved at the event or closure time.

Observed current-cycle age starts at the latest opening/reopening. If unavailable,
show unknown; do not substitute source renewal time or claim true time on market.
A renewal is not a newly discovered property. An observed exit is not a confirmed
sale or letting, and the final observed asking price is not a transaction price.
Historical exit panels use their historical population; a current-score filter
does not select past exits. Label the applicable filters in those panel descriptions.

Do not combine sale and rental prices into yields or produce commissions,
seller motivation, agent ownership or conversion estimates without supporting
data. These are outside this dashboard's comparison task.

## Data readiness and implementation boundaries

| Requirement | Current support and future work |
|---|---|
| Current listings and features | `reporting.current_listings`; add a future resolved current-price and score projection shared with the buyer/renter dashboards. |
| Comparable cohorts | Future reusable reporting logic implementing the same formula, exclusions and sample thresholds across all three dashboards. Keep the comparable list consistent with the displayed aggregate at one evaluation time. |
| Reductions | `price_changes_filtered` and canonical events; current review lists also enforce present availability and that the reduction still applies. |
| Daily neighbourhood trends | `reporting.daily_listing_facts`; preserve quality flags and historical attributes. Rental prices use the confirmed monthly basis; feature-filtered history requires historical feature evidence as described in the renter document. |
| Lifecycle and exits | `v_listing_lifecycle_cycles` and existing closure-time reporting such as `dashboard_public.exit_cycles`; use one row per cycle and frozen closure-time facts. |
| Freshness | Latest complete-search watermark for the selected scope and per-listing observation time. |
| Agent's own portfolio | No reliable ownership relationship is defined. A future portfolio view requires explicit mapping, rather than inferring ownership from seller type. |

These dependencies are future work. This specification does not create reporting
objects, change existing dashboards, expose new public data, add exports or
connect to a CRM. A hypothetical unlisted-property valuation form is also outside
version 1; the initial comparable workflow starts from an observed listing.

## Acceptance criteria for future implementation

- An agent can compare neighbourhoods, filter by price and open a reviewable
  listing with its exact local comparables from this dashboard.
- The same target and observation time produce the same score here and on the
  corresponding buyer/renter dashboard, regardless of budget or review view.
- Above-benchmark listings remain easy to find without reversing the score's
  meaning. Unscored listings never appear as zero-score overpriced candidates.
- Every comparable matches the required segment, neighbourhood, room bucket and
  area range; rental comparables also match furnishing and use monthly units.
- Reopenings reset current-cycle age, duplicate search memberships do not inflate
  counts, and absent source history is not described as true time on market.
- Historical exits retain closure-time prices and attributes, and changing the
  current-score filter does not rewrite historical exit counts.
- Switching to rent changes units to KM/month and KM/m²/month under the confirmed
  dataset rule; no price headline pools sale and rent.
