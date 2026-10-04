-- Daily 90-day listing inventory snapshots reconstructed from observed price
-- intervals and open/reopen/close cycles. This is asking price per square
-- metre for sale listings; it is not transaction or sale-price data.
WITH bounds AS (
  SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date - 89 AS start_day,
         (now() AT TIME ZONE 'Europe/Sarajevo')::date AS end_day
), sale_listings AS MATERIALIZED (
  SELECT article_id, sqm, first_seen
  FROM lean.listings
  WHERE deal = 'sale' AND sqm > 0
), openings AS (
  SELECT article_id, first_seen AS opened_at FROM sale_listings
  UNION ALL
  SELECT e.article_id, e.occurred_at AS opened_at
  FROM lean.listing_lifecycle_events e
  JOIN sale_listings s USING (article_id)
  WHERE e.event_type = 'reopened'
), cycles AS (
  SELECT o.article_id, o.opened_at, closed.closed_at
  FROM openings o
  LEFT JOIN LATERAL (
    SELECT min(e.occurred_at) AS closed_at
    FROM lean.listing_lifecycle_events e
    WHERE e.article_id = o.article_id
      AND e.event_type = 'closed'
      AND e.occurred_at > o.opened_at
  ) closed ON TRUE
), prior_prices AS (
  -- One indexed lookup per eligible listing preserves the price carried into
  -- the window without sorting every historical observation.
  SELECT s.article_id, price.price, price.price_date
  FROM sale_listings s
  CROSS JOIN bounds
  CROSS JOIN LATERAL (
    SELECT ph.price, ph.price_date
    FROM lean.price_history ph
    WHERE ph.article_id = s.article_id
      AND ph.source = 'api_price_history'
      AND ph.currency = 'BAM'
      AND ph.price > 0
      AND ph.price_date < bounds.start_day
    ORDER BY ph.price_date DESC
    LIMIT 1
  ) price
), window_prices AS (
  -- Fetch only observations that can change a value inside the 90-day window.
  SELECT s.article_id, price.price, price.price_date
  FROM sale_listings s
  CROSS JOIN bounds
  CROSS JOIN LATERAL (
    SELECT ph.price, ph.price_date
    FROM lean.price_history ph
    WHERE ph.article_id = s.article_id
      AND ph.source = 'api_price_history'
      AND ph.currency = 'BAM'
      AND ph.price > 0
      AND ph.price_date BETWEEN bounds.start_day AND bounds.end_day
  ) price
), price_spans AS (
  SELECT relevant.article_id, relevant.price, relevant.price_date,
         lead(relevant.price_date) OVER (
           PARTITION BY relevant.article_id ORDER BY relevant.price_date
         ) AS next_date
  FROM (
    SELECT * FROM prior_prices
    UNION ALL
    SELECT * FROM window_prices
  ) relevant
), daily AS (
  SELECT day.day::date AS day,
         span.price / NULLIF(listing.sqm, 0) AS price_per_sqm_bam
  FROM price_spans span
  CROSS JOIN bounds
  JOIN LATERAL generate_series(
    GREATEST(span.price_date, bounds.start_day),
    LEAST(COALESCE(span.next_date - 1, bounds.end_day), bounds.end_day),
    INTERVAL '1 day'
  ) day(day) ON TRUE
  JOIN cycles cycle
    ON cycle.article_id = span.article_id
   AND cycle.opened_at < day.day::date + 1
   AND (cycle.closed_at IS NULL OR cycle.closed_at >= day.day::date + 1)
  JOIN sale_listings listing
    ON listing.article_id = cycle.article_id
)
SELECT day,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY price_per_sqm_bam) AS p25_bam_per_sqm,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqm_bam) AS median_bam_per_sqm,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY price_per_sqm_bam) AS p75_bam_per_sqm,
       count(*) AS observed_listings
FROM daily
GROUP BY day
ORDER BY day
