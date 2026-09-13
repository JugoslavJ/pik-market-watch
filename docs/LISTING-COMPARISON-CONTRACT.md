# Private listing comparison contract

The buyer, renter and agent dashboards share version 1 of the **Local
asking-price score**. Higher means cheaper relative to comparable local asking
prices. It compares tracked asking prices; it is not an appraisal, confirmed
transaction price, or a prediction that a property is a bargain.

The implementation is additive in
[`16-listing-comparison.sql`](../db/init/16-listing-comparison.sql). Existing
checksummed migrations and public dashboard data contracts remain separate.

## Reporting interfaces

| Interface | Contract |
| --- | --- |
| `reporting.resolved_price_evidence` | One canonical assertion per article and effective timestamp, including invalid, conflict and unpriced boundaries. Original event fields, `currency_normalized`, and historically resolved `evidence_is_rent`. Future assertions are excluded. |
| `reporting.current_comparison_inputs` | One row per current article, resolved eligible total asking price/rate, quality reasons, type, rooms, neighbourhood, features and observed cycle age. |
| `reporting.current_listing_scores` | All current input columns plus shared benchmark, score, coverage, deviation, indicative spread and currently applicable reduction. No budget, recency, score or feature selection affects the cohort. |
| `reporting.listing_comparables(article_id bigint)` | Exact eligible cohort as input rows, sorted by article ID; excludes the subject. Available comparables remain inspectable below the ten-comparable threshold. |
| `reporting.comparison_price_changes` | Valid, same-segment, common-currency changes in the currently observed open cycle, including effective time, previous/current price, signed delta and percentage change. |
| `reporting.comparison_property_type(text[])` | A single known canonical type or null. |
| `reporting.comparison_currency(text)` | KM/BAM, ignoring case and surrounding whitespace, normalize to BAM. All other/absent evidence returns null; no currency conversion. |
| `reporting.comparison_price_reason(price,state,currency,is_rent)` | Null if total asking price is eligible; otherwise a readable reason. Independent of area. |
| `reporting.comparison_quality_reason(price,state,currency,sqm,is_rent)` | Null if the asking rate is eligible; otherwise a readable price or area reason. |
| `reporting.numeric_bound(text,label,maximum default null)` | Blank means unset; parses non-negative decimal notation and raises a readable error for malformed values or an exceeded maximum. |
| `reporting.within_bounds(value,min_text,max_text,label,maximum default null)` | Inclusive independent bounds; rejects reversed ranges. Missing values fail an active bound and pass when both bounds are unset. |

Price columns are `resolved_price` (the current canonical assertion's numeric
value, including rejected evidence), `asking_price` (eligible total asking price)
and `asking_rate` (eligible price divided by area). Display and numeric currency
filters use the eligible columns; a foreign or unknown currency never becomes a
KM amount. Total-price sample counts can exceed rate sample counts when area is
missing or invalid. `price_reason` and `score_input_reason` explain exclusions.

Core dimensions are `deal` (`sale`/`rent`), `property_type`,
`category_memberships`, `neighborhood`, `rooms`, `room_bucket` and `sqm`.
`furnished`, `parking`, `garage` and `elevator` are nullable booleans; unknown is
distinct from false. Other supported features are `condition`, `heating`,
`floor_num` and `seller_type`. Furnishing uses the latest explicitly recorded
furnishing observation, including a null that represents partial/unknown
furnishing, ahead of the current listing fallback.

Score output fields are `score`, `unscored_reason`, `comparable_count`,
`confidence`, `benchmark_rate`, `benchmark_p25`, `benchmark_p75`,
`deviation_pct`, `position_label`, `indicative_total`, `indicative_low`,
`indicative_high`, `asking_gap_km`, `benchmark_at` and `score_version`.
The `asking_gap_km` name also applies to the monthly gap for rentals.
Reduction fields are `latest_reduction_at`, positive `reduction_km` and positive
`reduction_pct`. Historical-window selection is applied by the dashboard to the
event timestamp; it never changes current inventory or the score cohort.

The evaluation uses PostgreSQL's stable transaction timestamp and statement
snapshot. Join subject and exact comparables within one SQL statement when a
single consistent detail snapshot is required. Separate requests may see a newly
ingested observation; display their `benchmark_at` values accordingly.

## Evidence and populations

Current means `closed_at IS NULL` and `last_seen > now() - interval '14 days'`.
Search memberships are aggregated before any comparisons, so overlapping searches
cannot multiply an article. Different OLX ads for one physical property remain
separate articles and can affect the benchmark.

Canonical price resolution orders by latest effective time, then modern
search/detail evidence ahead of legacy/import evidence, then conflict, invalid,
unpriced, valid, then descending event ID. A rejected latest assertion never
falls back to an older valid one. The price's recorded deal segment must match
the current segment, with no intervening sale/rent switch. Missing deal evidence
does not become sale by default.

Currency comes exclusively from the resolved price event's `provenance.currency`,
recorded from explicit upstream currency evidence by ingestion. A numeric price,
a synthesized price display string, the database column comment, or today's
currency on an earlier historical price is not verification. Older events without
currency provenance remain browsable but unpriced in eligible KM statistics and
unscored until newly observed verified evidence arrives.

The configured canonical categories in [`searches.example.json`](../config/searches.example.json)
map directly: `apartments` (OLX category 23), `houses` (24), and
`vacation_homes` (26). Unknown categories and memberships spanning different
types remain unscored. Custom search labels are not inferred from ad titles;
they require an explicit mapping change. A mapped neighbourhood must match the
configured neighbourhood table, from recorded location or the existing pin
mapping. Missing/unmapped locations remain browsable without a score.

Room buckets follow the existing numbered buckets (`0`, `1`, `2`, `3`, `4+`);
missing or nonnumeric room evidence cannot create an unknown-room cohort.

## Price-quality defaults

Sale prices retain the existing minimum of 3,000 BAM and area range of 5–500 m²,
inclusive. The existing parser's rounded rate plausibility range of
1–15,000 BAM/m² is used solely as an eligibility check. Score calculations use
the unrounded price divided by area.

**Monthly rental quality, version 1:** rental prices follow the project owner's
confirmed monthly dataset rule. Require a valid positive finite asking price of
at least 50 BAM/month, verified KM/BAM currency, and valid finite area of
5–500 m² inclusive. Derive the unrounded monthly rate directly from rent/area.
There is no borrowed sale-rate threshold or invented rental upper-rate cap.
These are conservative input-quality defaults, not measured valuation accuracy;
future changes to the policy must be versioned. Existing sale `ppm2` remains
unmodified and is not used for rental rates.

Rental scoring additionally requires known furnished/unfurnished status for both
target and comparables. Null/partial furnishing remains visible but unscored.
Utilities, deposits, agency fees and other move-in costs are not included or
filled with zero.

## Cohort, formula and boundaries

Other eligible current articles must match the target's neighbourhood, property
type, sale/rent segment and room bucket, and have area within 80–120% of the
target's area, inclusive. Rentals also match known furnishing status. There is no
fallback to a wider location or a different room/type cohort. Conditions, floor,
parking, land and renovation costs are not score adjustments. Houses and vacation
homes require the visible explanation “Building-area comparison; land and
condition not adjusted” and separate ranking from apartments.

Ten eligible comparables are required after subject exclusion. With 10–19,
coverage is “Limited sample”; with 20 or more it is “Larger sample”. These are
coverage labels, not statistical confidence guarantees. Below ten, benchmark,
derived indicative amounts and score remain null; the comparable count and
available rows remain visible. Missing facts have specific reasons, including
missing area, unmapped neighbourhood, unknown type/rooms/furnishing, invalid
price, conflicting evidence, currency uncertainty and insufficient comparables.

```text
benchmark_rate = median(comparable asking_price / sqm)
deviation_pct = 100 * (asking_rate / benchmark_rate - 1)
score = round(max(0, min(100, 50 - deviation_pct)))
indicative_total = benchmark_rate * target sqm
asking_gap_km = asking_price - indicative_total
```

The P25/P75 rates multiplied by subject area give the indicative spread of
comparable asks. This is not a prediction interval. An unscored article has null
score; zero is reserved for a valid score clamped at the lower end.

| Deviation | Position label |
| --- | --- |
| `< -10` | Well below local asking benchmark |
| `>= -10` and `< -5` | Below local asking benchmark |
| `>= -5` and `<= 5` | Near local asking benchmark |
| `> 5` and `<= 10` | Above local asking benchmark |
| `> 10` | Well above local asking benchmark |

## Observation age and reductions

`cycle_opened_at` and `current_cycle_age_days` come from the latest observed
opening/reopening cycle. Missing cycle evidence stays unknown. `first_seen`
remains first discovery; renewal time is not discovery or a cycle reset.
`reopened` means this is a later observed cycle. Neither age is a claim about
true time on market, confirmed availability or a completed transaction.

Reduction candidates require adjacent valid common-currency assertions in the
same deal series and current cycle. Repeated unchanged observations preserve a
reduction. A later increase, invalid/unpriced/conflicting assertion, foreign or
unknown currency, intervening deal change, or reopening removes an obsolete
reduction badge. A later price returning to the old reduced price after an
invalid boundary does not resurrect that old reduction. More recent independently
valid reductions may qualify on their own evidence.

Core regression coverage lives in
[`db-listing-comparison.test.js`](../scraper/test/integration/db-listing-comparison.test.js).
