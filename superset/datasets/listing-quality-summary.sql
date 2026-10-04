-- Live active inventory quality measures; do not cache this dataset.
SELECT
  count(*) FILTER (WHERE closed_at IS NULL)::integer AS active_listings,
  round(100.0 * count(*) FILTER (WHERE closed_at IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL)
    / nullif(count(*) FILTER (WHERE closed_at IS NULL), 0), 1) AS geo_pins_pct,
  round(100.0 * count(*) FILTER (WHERE closed_at IS NULL AND details_fetched_at IS NOT NULL)
    / nullif(count(*) FILTER (WHERE closed_at IS NULL), 0), 1) AS details_fetched_pct,
  round(100.0 * count(*) FILTER (WHERE closed_at IS NULL AND ppm2 > 0)
    / nullif(count(*) FILTER (WHERE closed_at IS NULL), 0), 1) AS price_per_sqm_known_pct,
  round(100.0 * count(*) FILTER (WHERE closed_at IS NULL AND api_status IS NOT NULL)
    / nullif(count(*) FILTER (WHERE closed_at IS NULL), 0), 1) AS olx_status_known_pct,
  count(*) FILTER (WHERE closed_at IS NULL
    AND (details_fetched_at IS NULL OR details_fetched_at < now() - interval '7 days')
    AND (last_enrichment_attempted_at IS NULL OR last_enrichment_attempted_at < now() - interval '12 hours'))::integer AS detail_backlog,
  count(*) FILTER (WHERE extra->>'latest_price_state' IN ('invalid', 'conflict')
    AND last_seen > now() - interval '30 days')::integer AS invalid_latest_price_30d
FROM lean.listings
