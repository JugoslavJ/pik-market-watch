# Real Estate Renter dashboard

Status: proposed specification. This document does not implement dashboard, SQL,
scraper, or provisioning changes.

## Purpose

Help a renter find a home within a recurring rent budget, compare neighbourhood
asking rents and identify interesting rentals below comparable local asking
rates. Prioritise affordability, size, furnishing and availability evidence.

Proposed dashboard title: **Find a home to rent**. Proposed UID: `olx-renter`.
This is an interactive private dashboard. Follow the
[shared listing-score contract](DASHBOARD-BUYER.md#shared-listing-score-contract-version-1)
for active inventory, deduplication, sample thresholds, score interpretation,
freshness and explanations, with the rental-specific rules below.

## Monthly rental basis

The project owner confirms that rental prices in this dataset are always per
month. Treat rental `price` as monthly asking rent throughout these specifications,
including historical rental evidence. Monthly filters, neighbourhood statistics
and rental scores are part of the first version; no per-listing period verification
or additional billing-period field is required.

Existing `ppm2` is intentionally null for rentals. Derive rental KM/m²/month from
valid monthly asking price divided by valid area, separately from sale `ppm2`.
Show “Rental prices are monthly” in the dashboard description. This dataset rule
defines the price unit; it does not establish a minimum lease duration.

## Filters and defaults

| Filter | Behaviour |
|---|---|
| Property type | Single select; default apartments. Keep houses and vacation homes separate. |
| Deal | Fixed to rent. |
| Rental basis | Fixed to monthly under the dataset rule. |
| Monthly asking rent, KM/month | Independently optional minimum and maximum. |
| Monthly rent per m² | Optional bounds, labelled KM/m²/month. |
| Neighbourhood | Multi-select; default all mapped neighbourhoods, with unknown locations available separately. |
| Area and rooms | Optional area bounds and room buckets. |
| Furnishing | Any, furnished, unfurnished or unknown. Never interpret null as unfurnished. |
| Features | Optional heating, parking, elevator, floor and seller type, where populated. |
| Listing selection | All matches, first observed in the last 7 days, reduced in the last 30 days, or below local asking benchmark. |
| Minimum score | Optional 0–100 threshold; default unset. |
| History window | Default 30 days; optional 90 days. Current inventory and scores remain evaluated now. |

Use inclusive bounds and explicit invalid-range messages as in the buyer spec.
Missing values do not satisfy an active filter. Label an unset budget as unset.
Do not offer deposit, pet policy, move-in date, lease term or utility-inclusion
filters until reliable structured evidence exists for those facts.

## Layout

| Row | Panel | What the renter sees |
|---|---|---|
| 1 | Rental search summary | Matching rentals, within-budget count when set, scored matches below local benchmark, eligible priced count and search freshness. |
| 2 | Rent by neighbourhood | Neighbourhood, monthly listing count, eligible priced count, median asking KM/month, P25–P75 KM/month, median KM/m²/month with its own sample count, and within-budget count. |
| 2 | Neighbourhood rent map | Colour by median monthly asking rent; tooltip includes size/room selection, spread and sample size. Selecting a neighbourhood filters listings. |
| 3 | Interesting rentals | Ranked listing table with local asking-price score, deviation, actual monthly rent, furnishing and clear reasons to inspect. |
| 4 | Space for the budget | Scatter plot of area versus monthly asking rent; score colour and an optional budget line. |
| 4 | Recent rent reductions | Currently observed offers with valid rent-to-rent reductions, absolute KM/month and percentage changes, and event date. |
| 5 | Rental detail | Ad link, monthly asking rent, area, features, comparable rentals, score explanation and asking-price history. |
| 5 | Rent trend | Daily neighbourhood median monthly rent and eligible sample count, with historical evidence-quality flags. |

Neighbourhood price panels use property type, area, rooms and supported feature
selections before price, score and recency filters; label them “Market context
before price filters”. Suppress price statistics below 10 eligible distinct
listings, keeping counts visible. The within-budget count uses the user's budget.
Show typical area alongside total-rent statistics so a shift toward larger homes
does not look like a like-for-like rent increase.

The main table contains title/link, neighbourhood, KM/month, m², KM/m²/month,
rooms, furnishing, local benchmark, deviation %, score, comparable count,
confidence, first observed, last seen and reduction/reason badges. Default order
is descending score, newest first observed, then article ID; unscored rows follow.
Allow sorting by lowest monthly rent and newest. Show 25 rows per page.

## Rental score

Use the buyer spec's cohort and formula with these additions:

- Both target and comparables must be rentals with a common currency. All rental
  prices use the dataset's monthly basis; property types remain separate.
- Calculate `listing_rate = monthly asking rent / valid area` in
  KM/m²/month. Require a future documented rental area/price-quality rule; sale
  plausibility thresholds do not automatically validate rental rates.
- Match the same neighbourhood, property type, room bucket and ±20% area band.
  Also require the same known furnished/unfurnished status. Unknown or partially
  furnished offers remain browsable but unscored in version 1; the current
  nullable furnished field cannot distinguish all such cases.
- Exclude the target and require at least 10 eligible comparables. Do not loosen
  furnishing or neighbourhood to produce a number.
- `benchmark_rate` is the median comparable KM/m²/month;
  `deviation_pct = 100 * (listing_rate / benchmark_rate - 1)` and
  `score = round(max(0, min(100, 50 - deviation_pct)))`.
- Budget, recency, score and optional feature filters do not change the target's
  cohort. Rent versus comparable asks is the score's sole input; feature badges
  and reductions remain separate.

Illustrative example: a furnished 50 m² apartment at 600 KM/month has a rate of
12 KM/m²/month. At a comparable median of 15 KM/m²/month, deviation is −20%,
score is 70, and the asking gap is −150 KM/month against an indicative 750 KM/month.

Use **Local asking-price score** with the same deviation labels as the buyer
dashboard. Explain that utilities, deposits, agency fees and unverified features
are not included. Display “Total move-in cost unknown” when those costs are absent;
never fill missing costs with zero. A recent sighting is observation evidence,
not confirmation that a home is ready to occupy.

## Data readiness and implementation boundaries

| Requirement | Current support and future work |
|---|---|
| Active rentals and details | `reporting.current_listings` provides `is_rent`, price, area, rooms and nullable features. Resolve current valid price evidence as described in the buyer spec. |
| Monthly rent and comparable rates | Treat rental `price` as KM/month under the confirmed dataset rule, subject to the common currency and valid-price rules. Compute a dedicated rental rate; never overwrite or reinterpret sale `ppm2`. |
| Furnishing comparability | Use populated `furnished` for known yes/no only; preserve unknown status and show coverage. |
| Rental price reductions | Use canonical valid-to-valid events within the rent segment and a common currency. Require the reduction to still apply to the current price. |
| Historical rent panels | `reporting.daily_listing_facts` has prices and quality flags. Aggregate valid rental prices as KM/month; derive per-m² rates separately where area is valid. Feature-filtered history requires historical feature evidence; do not apply today's furnishing to earlier days. |
| Freshness | Reuse complete-search watermarks and per-listing last seen; show unknown explicitly. |

Saved searches, alerts, landlord contact, application submission and persistent
favourites are outside the first dashboard version. Listing detail remains a
read-only inspection with a link to OLX.

## Acceptance criteria for future implementation

- A renter can set a monthly budget and compare neighbourhood asking rents from
  the first version without collecting an additional billing-period field.
- A valid rental price of 600 KM is displayed and filtered as 600 KM/month under
  the confirmed dataset rule, and may enter the appropriate monthly aggregate.
- Two otherwise comparable offers with different furnishing cannot enter the
  same score cohort. Fewer than 10 comparables means unscored.
- Changing the budget changes results without changing a surviving ad's score.
- The example produces score 70; null area and invalid current price produce
  specific unscored reasons, and missing fees remain unknown.
- A sale/rent switch never appears as a rent reduction, and historical panels
  use monthly rental prices with the recorded historical attributes and flags.
