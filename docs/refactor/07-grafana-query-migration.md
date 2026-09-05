# Grafana query migration

**Owner:** Provisioned dashboards and their SQL integration.  
**Dependencies:** [06 — Daily inventory and analytics](06-daily-inventory-and-analytics-views.md).  
**Shared rules:** [Contracts](00-contracts-and-dependencies.md).

## Changes

- Replace the Overview daily asking median and percentile band with the daily inventory interface.
- Replace the asking-price comparison in Exits and weekly comparison queries in Home and Overview.
- Move price-drop panels onto canonical price changes.
- Apply Category, Deal, Rooms, area and Neighborhood filters consistently before aggregation.
- Keep current headline statistics based on eligible current inventory; align their active/closed filtering.
- Show priced sample counts and identify reconstructed estimates, stale inventory and today's provisional value.
- Render empty priced populations as gaps, never zero.
- Set dashboard timezone to `Europe/Sarajevo`.
- Update descriptions to distinguish asking prices, exit askings, recorded inventory and inferred historical availability.
- Extend Health with incomplete searches, detail backlog, rejected history counts and analytics refresh age.

## Acceptance criteria

Parse all dashboard JSON and execute changed SQL against seeded PostgreSQL fixtures with representative Grafana variable expansion. Verify filters, empty results, historical closed listings and current-versus-daily consistency.
