-- One row per active BAM sale listing with a comparable positive asking price
-- per square metre. The table chart sorts this dataset from lowest ppm2 up.
SELECT
  l.article_id,
  l.title,
  l.url,
  CASE WHEN l.url ~ '^https://(www[.])?olx[.]ba/'
       THEN '<a href="' || replace(replace(replace(replace(l.url, '&', '&amp;'),
            '"', '%22'), '<', '%3C'), '>', '%3E')
            || '" target="_blank" rel="noopener noreferrer">Open ad</a>'
  END AS ad_link,
  COALESCE(l.property_type, 'Unknown') AS property_type,
  COALESCE(l.neighborhood, 'Unknown') AS neighborhood,
  COALESCE(l.rooms, 'Unknown') AS rooms,
  COALESCE(l.seller_type, 'Unknown') AS seller_type,
  l.sqm::double precision AS sqm,
  l.price::double precision AS price_bam,
  l.ppm2::double precision AS ppm2_bam
FROM lean.listings l
WHERE l.closed_at IS NULL
  AND l.deal = 'sale'
  AND l.currency = 'BAM'
  AND l.ppm2 > 0
