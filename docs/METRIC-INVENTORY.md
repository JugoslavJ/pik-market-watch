# Dashboard metric inventory

This inventory defines the dimensions that every provisioned panel must make
visible in its title, description, or query. It prevents a corrected SQL query
from silently retaining an obsolete metric label.

| Dashboard | Scope | Time basis | Population | Price rule | Uncertainty |
|---|---|---|---|---|---|
| Overview | Current inventory panels | Query time; active rows only | `listings_filtered` plus shared category, deal, room, area and neighborhood filters | Valid sale evidence with valid area for KM/m²; rent is separate | Missing area/pin is retained in inventory but excluded from derived ratios |
| Overview | Daily trend panels | Banja Luka calendar day | `listing_daily` through `market_daily_filtered` | Daily valid price and ppm² samples | Inferred attributes, stale observations and provisional today are exposed by the projection |
| Overview | Price-drop panels | Event effective time | `price_changes_filtered` | Resolved valid-to-valid changes only | Invalid/conflict/deal-boundary events suppress comparisons |
| Exits | Exit-cycle panels | Frozen closure cycle time | Closed listings and lifecycle projection | Closing price is the last observed asking price | A disappearance is an observed exit proxy, not confirmed sale |
| Home | Flow panels | Banja Luka day | Births, deaths and live-inventory projections | Counts, not priced samples | Backdated or inferred sightings are marked by projection metadata |
| Health | Scrape and analytics operations | Run completion and refresh time | Saved searches, scrape runs, queue state and refresh watermark | No market-price aggregation | Missing success/refresh state is shown as unknown and can alert |
| Buyer / Renter / Agent | Private current comparisons | Query time, observed within 14 days | `reporting.current_listing_scores`; one row per article | Verified BAM asking evidence; sale KM/m², rent KM/month and KM/m²/month; exact shared version 1 cohort | Null scores retain explicit reasons; neighbourhood statistics require 10 eligible listings; individual scores require 10 other comparables |
| Buyer / Renter / Agent | Private historical context | Sarajevo reconstructed day or observed lifecycle boundary | `reporting.daily_listing_facts`, `lifecycle_movements`, `lifecycle_cycles` | Historical assertion currency and features; separate total-price and rate samples | Inferred, stale and provisional evidence shown; closure prices are asking prices, never transactions |
| Public Home | Fixed tracked categories (`apartments`, `houses`, `vacation_homes`) | Query time for current rows; event time for reductions | `dashboard_public.current_listings`, `price_reductions`, and `freshness` | Sale KM/m² and rental asking price are reported separately by category | Category counts can overlap; missing success is Unknown |
| Public Apartments for Sale | Literal `apartments` + `sale` scope | Current 14-day observations and Sarajevo daily projections | `dashboard_public.current_listings` and `daily_market` | Valid sale price and area only; median plus explicit priced sample | Neighborhood aggregates require at least 10 eligible listings |
| Public Apartments for Rent | Literal `apartments` + `rent` scope | Current 14-day observations and event time | `dashboard_public.current_listings` and `price_reductions` | Asking price as listed; no monthly period is assumed | Publish only as an asking-price view until rental period is verified |
| Public Exits | Literal `apartments` + `sale` closure cycles | Closure-cycle time | `dashboard_public.exit_cycles` | Last valid asking price at closure, never a transaction price | Reopened cycles remain separate; invalid boundary price is NULL |

Shared filter semantics are implemented in [05-filters.sql](../db/init/05-filters.sql): empty multi-selects mean no
restriction, numeric bounds are independently optional, and the canonical deal
values are `sale` and `rent` (`sell` is accepted only as a compatibility input).
Queries that measure current inventory, event-time changes, daily projections,
and exit cycles intentionally use different time bases; a panel must state its
choice instead of implying that all dashboard numbers are directly comparable.

The public dashboards intentionally have no template variables. Their SQL uses
literal category/deal predicates over the allowlisted `dashboard_public` views;
the public PostgreSQL role cannot read the underlying evidence tables. Public
tables have a SQL limit of 50 rows and the UI defaults to the first 25 rows.
The first release uses fixed 30-day/7-day windows and does not expose a public
time picker. Sale and rental populations are never pooled for a headline
statistic, and no gross-yield or bargain/fair-value claim is published.

The unit test suite validates the dashboard JSON and shared query contracts.
Rendered Grafana interpolation and representative result values remain a
deployment-time verification task.
