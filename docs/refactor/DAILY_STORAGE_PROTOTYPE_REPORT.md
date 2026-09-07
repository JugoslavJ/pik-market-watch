# Daily storage prototype gate

The required release does not replace `listing_daily` until a disposable
restored snapshot demonstrates all three conditions:

1. exact parity for `(day, article_id)`, price states, memberships, inferred
   and stale flags, empty-day coverage, percentiles, closure/reopening results,
   and publication-history gaps;
2. lower complete allocation including dictionary tables, foreign keys, and
   indexes; and
3. no unexplained material regression in the rebuild or representative
   filtered dashboard queries.

`db/diagnostics/daily-storage-prototype.sql` records the current baseline and
the gate. It intentionally does not create a production shadow table: the
assessment snapshot measured repeated `filter_attributes` values, but did not
measure a valid replacement on an isolated restored database. Until that
prototype is run and passes, the existing daily representation remains the
rollback-safe analytical contract. This is an evidence-backed deferral, not a
claim that daily storage cannot be reduced.
