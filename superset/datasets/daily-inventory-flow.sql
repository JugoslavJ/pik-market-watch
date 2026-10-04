-- Daily observed additions, exits, and estimated active inventory.
-- Listing dates are already stored at Sarajevo local-day precision.
WITH bounds AS (
  SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date - 89 AS start_day,
         (now() AT TIME ZONE 'Europe/Sarajevo')::date AS end_day
), days AS (
  SELECT generate_series(start_day, end_day, interval '1 day')::date AS day
  FROM bounds
), event_days AS MATERIALIZED (
  -- Expand each listing's opening and optional closure into one event stream.
  -- Group once so the flow and active-inventory calculation share one scan.
  SELECT ev.day,
         sum(ev.new_n)::bigint AS new_n,
         sum(ev.closed_n)::bigint AS closed_n,
         sum(ev.active_delta)::bigint AS active_delta
  FROM lean.listings listing
  CROSS JOIN LATERAL (VALUES
    (listing.first_seen, 1::bigint, 0::bigint, 1::bigint),
    (listing.closed_at, 0::bigint, 1::bigint, 0::bigint),
    (listing.closed_at + 1, 0::bigint, 0::bigint, -1::bigint)
  ) AS ev(day, new_n, closed_n, active_delta)
  WHERE ev.day IS NOT NULL
  GROUP BY ev.day
), seed AS (
  -- Closures count as active through their closure date, then leave inventory
  -- the following day. Include opening and closure transitions before window.
  SELECT coalesce(sum(active_delta), 0)::bigint AS active_n
  FROM event_days CROSS JOIN bounds
  WHERE event_days.day < bounds.start_day
), flow AS (
  SELECT days.day,
         coalesce(event_days.new_n, 0)::bigint AS new_n,
         coalesce(event_days.closed_n, 0)::bigint AS closed_n,
         coalesce(event_days.active_delta, 0)::bigint AS active_delta
  FROM days
  LEFT JOIN event_days USING (day)
), active AS (
  SELECT flow.*,
         seed.active_n + sum(flow.active_delta) OVER (ORDER BY flow.day)
           AS estimated_active_n
  FROM flow CROSS JOIN seed
)
SELECT day,
       new_n::integer AS new_n,
       closed_n::integer AS closed_n,
       estimated_active_n::integer AS estimated_active_n,
       round(100.0 * closed_n / nullif(estimated_active_n, 0), 2) AS closed_per_active_pct
FROM active
ORDER BY day
