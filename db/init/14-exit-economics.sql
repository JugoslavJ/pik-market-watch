-- Exit panels need only the first valid asking price and lifetime duration.
-- Keep these lookups correlated to each selected listing instead of sorting
-- and aggregating the entire history through v_listing_lifecycle. Existing
-- (article_id, effective_at, id) indexes support both scan directions.
CREATE OR REPLACE VIEW v_listing_exit_economics AS
SELECT l.article_id, fp.opening_price,
       CASE WHEN COALESCE(fs.effective_at, l.first_seen) IS NULL THEN NULL ELSE
         greatest(round(extract(epoch FROM (
           COALESCE(CASE WHEN ls.event_type = 'closed' THEN ls.effective_at
                         ELSE l.closed_at END, now())
           - COALESCE(fs.effective_at, l.first_seen)
         )) / 86400.0)::int, 0)
       END AS days_listed
  FROM listings l
  LEFT JOIN LATERAL (
    SELECT h.effective_at
      FROM listing_state_history h
     WHERE h.article_id = l.article_id
       AND h.event_type IN ('search_sighting', 'reopened')
     ORDER BY h.effective_at, h.id
     LIMIT 1
  ) fs ON true
  LEFT JOIN LATERAL (
    SELECT h.event_type, h.effective_at
      FROM listing_state_history h
     WHERE h.article_id = l.article_id
       AND h.event_type IN ('search_sighting', 'closed', 'reopened')
     ORDER BY h.effective_at DESC, h.id DESC
     LIMIT 1
  ) ls ON true
  LEFT JOIN LATERAL (
    SELECT e.price AS opening_price
      FROM listing_price_events e
     WHERE e.article_id = l.article_id AND e.price_state = 'valid'
     ORDER BY e.effective_at, e.id
     LIMIT 1
  ) fp ON true;

COMMENT ON VIEW v_listing_exit_economics IS
  'Indexed per-listing subset of v_listing_lifecycle; preserves lifetime duration and first valid asking price, including legacy fallbacks.';
