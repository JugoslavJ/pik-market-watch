-- Recorded asking-price reductions for active listings, based only on
-- consecutive API-reported BAM prices. A reduction is not a sale.
WITH history AS (
  SELECT ph.article_id, ph.price_date, ph.price, ph.currency,
         lag(ph.price) OVER (PARTITION BY ph.article_id ORDER BY ph.price_date) AS previous_price,
         lag(ph.currency) OVER (PARTITION BY ph.article_id ORDER BY ph.price_date) AS previous_currency
  FROM lean.price_history ph
  WHERE ph.source = 'api_price_history'
), drops AS (
  SELECT article_id, price_date, previous_price, price
  FROM history
  WHERE previous_price > price
    AND currency = 'BAM'
    AND previous_currency = 'BAM'
)
SELECT d.article_id,
       d.price_date,
       l.deal,
       COALESCE(l.property_type, 'Unknown') AS property_type,
       COALESCE(l.neighborhood, 'Unknown') AS neighborhood,
       COALESCE(l.rooms, 'Unknown') AS rooms,
       l.sqm::double precision AS sqm,
       d.previous_price::double precision AS previous_price_bam,
       d.price::double precision AS price_bam,
       (d.previous_price - d.price)::double precision AS reduction_bam,
       CASE WHEN l.deal = 'rent' THEN 'monthly rent' ELSE 'asking price' END AS price_kind,
       l.title,
       l.url,
       CASE WHEN l.url ~ '^https://(www[.])?olx[.]ba/'
            THEN '<a href="' || replace(replace(replace(replace(l.url, '&', '&amp;'),
                 '"', '%22'), '<', '%3C'), '>', '%3E')
                 || '" target="_blank" rel="noopener noreferrer">Open ad</a>'
       END AS ad_link
FROM drops d
JOIN lean.listings l USING (article_id)
WHERE l.closed_at IS NULL
