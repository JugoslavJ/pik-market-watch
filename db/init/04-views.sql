-- Current dashboard and evidence views.

CREATE OR REPLACE VIEW v_active_listings AS
SELECT article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
       location, latitude, longitude, closed_at, closing_price, closing_ppm2,
       closing_category,
       published_at, seller_type, rooms_detail, bathrooms, floor_num, floors_total,
       unit_levels, heating, furnished, condition, parking, garage, elevator,
       year_built, plot_sqm, orientation, views, favorites, characteristics,
       details_fetched_at, first_seen, last_seen, renewed_at
FROM listings
WHERE last_seen > now() - INTERVAL '14 days'
  AND closed_at IS NULL;

CREATE OR REPLACE VIEW v_listing_daily AS
SELECT d.day, d.article_id, l.title, l.url,
       d.category, d.category_memberships, d.is_rent,
       CASE WHEN d.is_rent THEN 'rent' ELSE 'sale' END AS deal,
       d.rooms, d.sqm, d.location, d.neighborhood,
       d.price, d.price_state, d.ppm2,
       d.state_effective_at, d.price_effective_at,
       d.membership_inferred, d.attributes_inferred,
       d.stale_observation, d.provisional_day, d.filter_attributes
  FROM listing_daily d
  JOIN listings l ON l.article_id = d.article_id;

CREATE OR REPLACE VIEW v_listing_price_changes AS
WITH state_at_event AS (
  SELECT e.*,
         s.is_rent,
         s.sqm,
         s.rooms,
         s.category,
         s.category_membership,
         s.filter_attributes
    FROM listing_price_events e
    LEFT JOIN LATERAL (
      SELECT h.*
        FROM listing_state_history h
       WHERE h.article_id = e.article_id
         AND h.effective_at <= e.effective_at
       ORDER BY h.effective_at DESC, h.id DESC
       LIMIT 1
    ) s ON TRUE
   WHERE NOT (
     e.source LIKE 'legacy%'
     AND EXISTS (
       SELECT 1
         FROM listing_price_events newer
        WHERE newer.article_id = e.article_id
          AND newer.effective_at = e.effective_at
          AND newer.source IN ('search', 'detail')
     )
   )
),
resolved_at_time AS (
  SELECT DISTINCT ON (article_id, effective_at)
         x.*
    FROM state_at_event x
   -- Keep this order identical to the daily projection: current search/detail
   -- assertions outrank imported/legacy rows; within that group conflict,
   -- invalid, unpriced, then valid states are chosen; id breaks ties.
   ORDER BY article_id, effective_at,
            CASE WHEN source IN ('search', 'detail') THEN 0 ELSE 1 END,
            CASE price_state
              WHEN 'conflict' THEN 0
              WHEN 'invalid' THEN 1
              WHEN 'unpriced' THEN 2
              ELSE 3
            END,
            id DESC
),
ordered AS (
  SELECT r.*,
         lag(r.price) OVER w AS prior_price,
         lag(r.price_state) OVER w AS prior_state,
         lag(r.effective_at) OVER w AS prior_effective_at,
         lag(CASE WHEN r.is_rent THEN 'rent' ELSE 'sale' END) OVER w AS prior_deal
    FROM resolved_at_time r
  WINDOW w AS (PARTITION BY r.article_id ORDER BY r.effective_at, r.id)
)
SELECT article_id,
       effective_at,
       ingested_at,
       source,
       price,
       price_state,
       CASE WHEN is_rent THEN 'rent' ELSE 'sale' END AS deal,
       prior_price,
       CASE WHEN price_state = 'valid'
                  AND prior_state = 'valid'
                  AND prior_deal = CASE WHEN is_rent THEN 'rent' ELSE 'sale' END
            THEN price - prior_price END AS delta,
       CASE WHEN price_state = 'valid'
                  AND prior_state = 'valid'
                  AND prior_deal = CASE WHEN is_rent THEN 'rent' ELSE 'sale' END
                  AND prior_price <> 0
            THEN (price - prior_price) / prior_price * 100 END AS pct_change,
       prior_effective_at,
       effective_at AS current_effective_at,
       category,
       category_membership AS category_memberships,
       sqm,
       rooms,
       filter_attributes AS provenance,
       false AS null_boundary
  FROM ordered
 WHERE price_state = 'valid'
   AND price IS NOT NULL
   AND prior_state = 'valid'
   AND prior_price IS NOT NULL
   -- A sale/rent transition is a new price series.  It must not be rendered
   -- as a price cut or increase even when the numeric values differ.
   AND prior_deal = CASE WHEN is_rent THEN 'rent' ELSE 'sale' END
   AND price IS DISTINCT FROM prior_price;

CREATE OR REPLACE VIEW v_listing_lifecycle_cycles AS
WITH markers AS (
  SELECT article_id, effective_at AS opened_at, id AS marker_id
    FROM (
      SELECT DISTINCT ON (article_id) article_id, effective_at, id
        FROM listing_state_history
       WHERE event_type = 'search_sighting'
       ORDER BY article_id, effective_at, id
    ) first_search
  UNION ALL
  SELECT article_id, effective_at, id
    FROM listing_state_history WHERE event_type = 'reopened'
),
numbered AS (
  SELECT m.*, row_number() OVER (PARTITION BY article_id ORDER BY opened_at, marker_id) AS cycle_no,
         lead(opened_at) OVER (PARTITION BY article_id ORDER BY opened_at, marker_id) AS next_opened_at
    FROM markers m
),
cycles AS (
  SELECT n.*,
         c.closed_at
    FROM numbered n
    LEFT JOIN LATERAL (
      SELECT s.effective_at AS closed_at
        FROM listing_state_history s
       WHERE s.article_id = n.article_id AND s.event_type = 'closed'
         AND s.effective_at >= n.opened_at
         AND (n.next_opened_at IS NULL OR s.effective_at < n.next_opened_at)
       ORDER BY s.effective_at, s.id LIMIT 1
    ) c ON TRUE
)
SELECT c.article_id, c.cycle_no, c.opened_at, c.closed_at,
       fp.effective_at AS first_price_at, fp.price AS opening_price,
       (c.closed_at IS NOT NULL) AS is_closed,
       CASE WHEN c.closed_at IS NULL THEN NULL
            ELSE greatest(round(extract(epoch FROM (c.closed_at - c.opened_at)) / 86400.0)::int, 0) END AS days_listed
  FROM cycles c
  LEFT JOIN LATERAL (
    SELECT e.effective_at, e.price FROM listing_price_events e
     WHERE e.article_id = c.article_id AND e.price_state = 'valid'
       AND e.effective_at >= c.opened_at
       AND (c.closed_at IS NULL OR e.effective_at <= c.closed_at)
     ORDER BY e.effective_at, e.id LIMIT 1
  ) fp ON TRUE;

CREATE OR REPLACE VIEW v_listing_lifecycle AS
WITH first_state AS (
  SELECT DISTINCT ON (article_id) * FROM listing_state_history
   WHERE event_type IN ('search_sighting', 'reopened')
   ORDER BY article_id, effective_at, id
),
last_state AS (
  SELECT DISTINCT ON (article_id) article_id, event_type, effective_at
    FROM listing_state_history
   WHERE event_type IN ('search_sighting', 'closed', 'reopened')
   ORDER BY article_id, effective_at DESC, id DESC
),
prices AS (
  SELECT e.article_id, min(e.effective_at) AS first_price_at,
         (array_agg(e.price ORDER BY e.effective_at, e.id))[1] AS opening_price,
         NULL::numeric AS opening_ppm2,
         max(e.effective_at) AS last_change_at,
         (array_agg(e.price ORDER BY e.effective_at DESC, e.id DESC))[1] AS last_history_price,
         NULL::numeric AS last_history_ppm2,
         count(*)::int AS n_changes, min(e.price) AS min_price, max(e.price) AS max_price
    FROM listing_price_events e
   WHERE e.price_state = 'valid'
   GROUP BY e.article_id
)
SELECT l.article_id, l.title, l.url, fs.sqm, fs.rooms, room_bucket(fs.rooms) AS room_bucket,
       fs.is_rent,
       COALESCE(fs.category, l.closing_category, (SELECT ss.category FROM search_results sr
                              JOIN saved_searches ss USING (search_key)
                              WHERE sr.article_id = l.article_id
                              ORDER BY ss.created_at LIMIT 1)) AS category,
       fs.category_membership AS category_memberships,
       COALESCE(fs.effective_at, l.first_seen) AS opened_at, p.first_price_at, p.opening_price,
       p.opening_ppm2, p.last_change_at, p.last_history_price, p.last_history_ppm2,
       p.n_changes, p.min_price, p.max_price,
       l.price AS current_price, l.ppm2 AS current_ppm2,
       CASE WHEN ls.event_type = 'closed' THEN ls.effective_at END AS closed_at,
       l.closing_price, l.closing_ppm2, l.closing_category,
       COALESCE(ls.event_type = 'closed', l.closed_at IS NOT NULL, false) AS is_closed,
       (SELECT count(*)::int FROM listing_state_history r
         WHERE r.article_id = l.article_id AND r.event_type = 'reopened') AS reopen_count,
       l.published_at, l.renewed_at, COALESCE(fs.effective_at, l.first_seen) AS first_seen,
       CASE WHEN COALESCE(fs.effective_at, l.first_seen) IS NULL THEN NULL ELSE
         greatest(round(extract(epoch FROM (COALESCE(CASE WHEN ls.event_type = 'closed' THEN ls.effective_at ELSE l.closed_at END, now()) - COALESCE(fs.effective_at, l.first_seen))) / 86400.0)::int, 0)
       END AS days_listed,
       CASE WHEN l.renewed_at IS NOT NULL THEN
         greatest(round(extract(epoch FROM
           (COALESCE(CASE WHEN ls.event_type = 'closed' THEN ls.effective_at END, now()) - l.renewed_at)) / 86400.0)::int, 0)
       END AS days_since_renewal
  FROM listings l
  LEFT JOIN first_state fs ON fs.article_id = l.article_id
  LEFT JOIN last_state ls ON ls.article_id = l.article_id
  LEFT JOIN prices p ON p.article_id = l.article_id;

CREATE OR REPLACE VIEW v_market_daily AS
WITH bounds AS (
  SELECT min(day) AS first_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date AS last_day
    FROM listing_daily
), grid AS (
  SELECT d::date AS day FROM bounds b
   CROSS JOIN LATERAL generate_series(COALESCE(b.first_day, b.last_day), b.last_day, interval '1 day') s(d)
), flows AS (
  SELECT day, sum(new_n)::int AS new_n, sum(closed_n)::int AS closed_n,
         sum(reopened_n)::int AS reopened_n
    FROM (
      SELECT (effective_at AT TIME ZONE 'Europe/Sarajevo')::date AS day,
             0::int AS new_n,
             count(*) FILTER (WHERE event_type = 'closed')::int AS closed_n,
             count(*) FILTER (WHERE event_type = 'reopened')::int AS reopened_n
        FROM listing_state_history
       WHERE event_type IN ('closed', 'reopened')
       GROUP BY 1
      UNION ALL
      SELECT (l.first_seen AT TIME ZONE 'Europe/Sarajevo')::date, 1, 0, 0
        FROM listings l
      UNION ALL
      SELECT (l.closed_at AT TIME ZONE 'Europe/Sarajevo')::date, 0, 1, 0
        FROM listings l
       WHERE l.closed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id = l.article_id AND h.event_type = 'closed' AND h.effective_at = l.closed_at)
    ) events
   GROUP BY day
), inventory_raw AS (
  SELECT day, count(*)::int AS active_est,
         count(*) FILTER (WHERE stale_observation)::int AS stale_n,
         bool_or(provisional_day) AS provisional_day
    FROM listing_daily GROUP BY day
  UNION ALL
  SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date,
         count(*)::int, 0, true
    FROM listings l
   WHERE l.closed_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id = l.article_id)
), inventory AS (
  SELECT day, sum(active_est)::int AS active_est, sum(stale_n)::int AS stale_n,
         bool_or(provisional_day) AS provisional_day
    FROM inventory_raw GROUP BY day
)
SELECT g.day, COALESCE(f.new_n, 0) AS new_n, COALESCE(f.closed_n, 0) AS closed_n,
       COALESCE(f.reopened_n, 0) AS reopened_n,
       COALESCE(i.active_est, 0) AS active_est,
       COALESCE(i.stale_n, 0) AS stale_n,
       COALESCE(i.provisional_day, g.day = (now() AT TIME ZONE 'Europe/Sarajevo')::date) AS provisional_day
  FROM grid g LEFT JOIN flows f USING (day) LEFT JOIN inventory i USING (day)
 ORDER BY g.day;

COMMENT ON VIEW v_listing_price_changes IS
  'Resolved price transitions; same-time evidence follows daily precedence and invalid/conflict/deal boundaries are suppressed.';
