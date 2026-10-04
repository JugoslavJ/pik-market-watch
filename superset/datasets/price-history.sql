-- Source-reported asking-price observations. Search markers are excluded.
-- Monetary fields are BAM only; rent values are monthly asking rents.
WITH observed AS (
  SELECT
    ph.article_id,
    ph.price_date,
    ph.price,
    ph.currency,
    ph.source,
    lag(ph.price) OVER (
      PARTITION BY ph.article_id ORDER BY ph.price_date
    ) AS previous_price,
    lag(ph.currency) OVER (
      PARTITION BY ph.article_id ORDER BY ph.price_date
    ) AS previous_currency
  FROM lean.price_history ph
  WHERE ph.source = 'api_price_history'
)
SELECT
  h.article_id,
  h.price_date,
  l.deal,
  COALESCE(l.property_type, 'Unknown') AS property_type,
  COALESCE(l.neighborhood, 'Unknown') AS neighborhood,
  COALESCE(l.rooms, 'Unknown') AS rooms,
  CASE WHEN h.currency = 'BAM' THEN h.price::double precision END AS price_bam,
  CASE WHEN h.previous_currency = 'BAM' THEN h.previous_price::double precision END AS previous_price_bam,
  CASE WHEN h.currency = 'BAM' AND h.previous_currency = 'BAM'
       AND h.previous_price > h.price
       THEN (h.previous_price - h.price)::double precision END AS reduction_bam,
  CASE WHEN l.deal = 'rent' THEN 'monthly rent' ELSE 'asking price' END AS price_kind,
  h.source,
  l.title,
  l.url,
  CASE WHEN l.url ~ '^https://(www[.])?olx[.]ba/'
       THEN '<a href="' || replace(replace(replace(replace(l.url, '&', '&amp;'),
            '"', '%22'), '<', '%3C'), '>', '%3E')
            || '" target="_blank" rel="noopener noreferrer">Open ad</a>'
  END AS ad_link
FROM observed h
JOIN lean.listings l USING (article_id)
