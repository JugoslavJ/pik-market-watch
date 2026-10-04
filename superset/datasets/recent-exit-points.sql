-- Geocoded observed closure snapshots matching the source exit-map window.
-- An exit is an observed ad closure, not a confirmed sale.
SELECT
  e.id AS event_id,
  e.article_id,
  e.occurred_at AS exit_date,
  e.occurred_at - e.opened_at AS days_listed,
  e.deal,
  COALESCE(e.property_type, 'Unknown') AS property_type,
  COALESCE(e.neighborhood, 'Unknown') AS neighborhood,
  COALESCE(e.rooms, 'Unknown') AS rooms,
  e.sqm::double precision AS sqm,
  CASE WHEN l.currency = 'BAM' THEN e.price::double precision END AS last_asking_price_bam,
  CASE WHEN e.deal = 'rent' THEN 'monthly rent' ELSE 'asking price' END AS price_kind,
  e.latitude,
  e.longitude,
  e.title,
  e.url,
  CASE WHEN e.url ~ '^https://(www[.])?olx[.]ba/'
       THEN '<a href="' || replace(replace(replace(replace(e.url, '&', '&amp;'),
            '"', '%22'), '<', '%3C'), '>', '%3E')
            || '" target="_blank" rel="noopener noreferrer">Open ad</a>'
  END AS ad_link
FROM lean.listing_lifecycle_events e
JOIN lean.listings l USING (article_id)
WHERE e.event_type = 'closed'
  AND e.occurred_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 90
  AND e.latitude IS NOT NULL
  AND e.longitude IS NOT NULL
