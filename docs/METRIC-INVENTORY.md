# Dashboard metric inventory

This inventory defines the dimensions that every provisioned panel must make
visible in its title, description, or query. It prevents a corrected SQL query
from silently retaining an obsolete metric label.

| Dashboard | Scope | Time basis | Population | Price rule | Uncertainty |
|---|---|---|---|---|---|
| Overview | Current inventory panels | Query time; active rows only | `listings_filtered` plus shared category, deal, room, area and neighborhood filters | Valid sale evidence with valid area for KM/m²; rent is separate | Missing area/pin is retained in inventory but excluded from derived ratios |
| Overview | Daily trend panels | Sarajevo calendar day | `listing_daily` through `market_daily_filtered` | Daily valid price and ppm² samples | Inferred attributes, stale observations and provisional today are exposed by the projection |
| Overview | Price-drop panels | Event effective time | `price_changes_filtered` | Resolved valid-to-valid changes only | Invalid/conflict/deal-boundary events suppress comparisons |
| Exits | Exit-cycle panels | Frozen closure cycle time | Closed listings and lifecycle projection | Closing price is the last observed asking price | A disappearance is an observed exit proxy, not confirmed sale |
| Home | Flow panels | Sarajevo day | Births, deaths and live-inventory projections | Counts, not priced samples | Backdated or inferred sightings are marked by projection metadata |
| Health | Scrape and analytics operations | Run completion and refresh time | Saved searches, scrape runs, queue state and refresh watermark | No market-price aggregation | Missing success/refresh state is shown as unknown and can alert |

Shared filter semantics are implemented in [17-dashboard-filter-contract.sql](../db/init/17-dashboard-filter-contract.sql): empty multi-selects mean no
restriction, numeric bounds are independently optional, and the canonical deal
values are `sale` and `rent` (`sell` is accepted only as a compatibility input).
Queries that measure current inventory, event-time changes, daily projections,
and exit cycles intentionally use different time bases; a panel must state its
choice instead of implying that all dashboard numbers are directly comparable.

The CI `npm run test:dashboards` check validates dashboard JSON structure,
unique panel IDs, and SQL target shape. It complements the SQL contract tests;
rendered Grafana interpolation and representative result values remain a
deployment-time verification task.
