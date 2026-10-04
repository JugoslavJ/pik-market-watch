-- One row per active listing and saved-search category. Keep this bridge
-- separate from active_listings so ordinary listing counts stay one per ad.
SELECT DISTINCT
  l.article_id,
  ss.category,
  l.title,
  l.deal,
  COALESCE(l.property_type, 'Unknown') AS property_type,
  COALESCE(l.neighborhood, 'Unknown') AS neighborhood,
  COALESCE(l.rooms, 'Unknown') AS rooms,
  COALESCE(l.seller_type, 'Unknown') AS seller_type,
  l.sqm::double precision AS sqm,
  CASE WHEN l.currency = 'BAM' THEN l.price::double precision END AS price_bam,
  CASE WHEN l.currency = 'BAM' THEN l.ppm2::double precision END AS ppm2_bam,
  l.url,
  CASE WHEN l.url ~ '^https://(www[.])?olx[.]ba/'
       THEN '<a href="' || replace(replace(l.url, '&', '&amp;'), '"', '%22')
            || '" target="_blank" rel="noopener noreferrer">Open ad</a>'
  END AS ad_link
FROM lean.listings l
CROSS JOIN LATERAL unnest(l.search_keys) AS listing_search(search_key)
JOIN lean.saved_searches ss USING (search_key)
WHERE l.closed_at IS NULL
  AND ss.category IS NOT NULL
