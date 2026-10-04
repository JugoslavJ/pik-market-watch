-- Operational listing coverage and quality facts. This dataset is deliberately
-- uncached so the scraper dashboard reflects recent enrichment attempts.
SELECT
  l.article_id,
  l.title,
  l.url,
  l.deal,
  COALESCE(l.neighborhood, 'Unknown') AS neighborhood,
  l.last_seen,
  l.latitude IS NOT NULL AND l.longitude IS NOT NULL AS has_coordinates,
  l.details_fetched_at,
  (l.details_fetched_at IS NOT NULL AND l.details_fetched_at >= now() - interval '7 days') AS details_fresh,
  l.ppm2 > 0 AS has_price_per_sqm,
  l.api_status IS NOT NULL AS has_api_status,
  l.api_status,
  l.closed_at IS NOT NULL AS marked_closed,
  l.details_fetched_at IS NULL OR l.details_fetched_at < now() - interval '7 days' AS details_old,
  l.last_enrichment_attempted_at,
  l.closed_at IS NULL
    AND (l.details_fetched_at IS NULL OR l.details_fetched_at < now() - interval '7 days')
    AND (l.last_enrichment_attempted_at IS NULL OR l.last_enrichment_attempted_at < now() - interval '12 hours') AS detail_backlog,
  l.extra->>'latest_price_state' AS latest_price_state
FROM lean.listings l
WHERE l.last_seen > now() - interval '30 days'
