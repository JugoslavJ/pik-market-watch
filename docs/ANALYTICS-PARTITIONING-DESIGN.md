# Analytics partitioning follow-up

The Phase 1 fix keeps inheritance partitions in place and repairs the child
indexes. On the live volume, article lookups switched from timestamp-index
scans with filtering to child-local `(article_id, effective_at, id)` index
scans; a one-day rebuild completed in 4.9 seconds after the repair.

Declarative partitioning remains a Phase 2 design, not a migration in this
change. It would remove the per-row routing trigger and propagate indexes, but
it requires:

- deduplicating existing price events before enforcing a partitioned primary
  key and unique identities;
- changing history primary keys to include the partition key (`id,
  effective_at` or the corresponding event timestamp);
- moving each inheritance child into a declarative partition inside a bounded
  maintenance window; and
- validating every foreign key, append-only trigger, view, and restore path.

Revisit this only if trigger CPU or cross-partition pruning remains a measured
problem after the child-index, rebuild, and publication changes. The current
evidence does not justify that higher-risk conversion yet.
