-- One row per active listing. Market charts use this dataset so a click
-- filter has the same meaning everywhere. Monetary values are BAM only.
SELECT
  l.article_id,
  l.title,
  l.url,
  CASE WHEN l.url ~ '^https://(www[.])?olx[.]ba/'
       THEN '<a href="' || replace(replace(replace(replace(l.url, '&', '&amp;'),
            '"', '%22'), '<', '%3C'), '>', '%3E')
            || '" target="_blank" rel="noopener noreferrer">Open ad</a>'
  END AS ad_link,
  l.deal,
  COALESCE(l.property_type, 'Unknown') AS property_type,
  COALESCE(l.neighborhood, 'Unknown') AS neighborhood,
  COALESCE(l.rooms, 'Unknown') AS rooms,
  COALESCE(l.seller_type, 'Unknown') AS seller_type,
  CASE WHEN l.deal = 'rent' THEN 'monthly rent' ELSE 'asking price' END AS price_kind,
  l.sqm::double precision AS sqm,
  CASE WHEN l.currency = 'BAM' THEN l.price::double precision END AS price_bam,
  CASE WHEN l.currency = 'BAM' THEN l.ppm2 END AS ppm2_bam,
  l.first_seen,
  l.last_seen,
  l.latitude,
  l.longitude,
  l.floor_num,
  l.year_built,
  l.parking,
  l.elevator,
  l.condition,
  CASE WHEN l.extra->>'views' ~ '^[0-9]+$' THEN (l.extra->>'views')::bigint END AS views
FROM lean.listings l
WHERE l.closed_at IS NULL
