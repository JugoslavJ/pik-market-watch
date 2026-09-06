-- Public dashboard reporting contract.
--
-- These views are deliberately additive and expose only the fields used by
-- the externally shared dashboards.  The public login is granted SELECT on
-- these views by zz-database-roles.sh; it receives no access to the evidence
-- tables, sequences, or application functions.

CREATE SCHEMA IF NOT EXISTS dashboard_public;
REVOKE ALL ON SCHEMA dashboard_public FROM PUBLIC;

CREATE OR REPLACE VIEW dashboard_public.current_listings AS
SELECT l.article_id,
       CASE WHEN l.url ~ '^https?://(www\.)?olx\.ba/artikal/[0-9]+/?$'
            THEN l.url END AS url,
       l.title,
       COALESCE(m.categories, '{}'::text[]) AS category_memberships,
       CASE WHEN l.is_rent THEN 'rent' ELSE 'sale' END AS deal,
       l.sqm,
       l.rooms,
       l.price,
       l.ppm2,
       COALESCE(NULLIF(l.location, ''),
                CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END) AS neighborhood,
       l.latitude,
       l.longitude,
       l.published_at,
       l.first_seen,
       l.renewed_at,
       l.last_seen,
       l.views
  FROM listings l
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT ss.category ORDER BY ss.category)
             FILTER (WHERE NULLIF(btrim(ss.category), '') IS NOT NULL) AS categories
      FROM search_results sr
      JOIN saved_searches ss ON ss.search_key = sr.search_key
     WHERE sr.article_id = l.article_id
  ) m ON TRUE
 WHERE l.closed_at IS NULL
   AND l.last_seen > now() - INTERVAL '14 days';

CREATE OR REPLACE VIEW dashboard_public.daily_market AS
SELECT d.day,
       d.article_id,
       COALESCE(NULLIF(d.category_memberships, '{}'::text[]),
                CASE WHEN d.category IS NULL THEN '{}'::text[]
                     ELSE ARRAY[d.category] END) AS category_memberships,
       CASE WHEN d.is_rent IS TRUE THEN 'rent'
            WHEN d.is_rent IS FALSE THEN 'sale'
            ELSE 'unknown' END AS deal,
       d.sqm,
       d.rooms,
       d.price,
       d.price_state,
       d.ppm2,
       COALESCE(NULLIF(d.neighborhood, ''),
                CASE WHEN d.location IS NULL THEN '(unmapped)' ELSE d.location END) AS neighborhood,
       d.stale_observation,
       d.provisional_day,
       d.membership_inferred,
       d.attributes_inferred
  FROM listing_daily d;

CREATE OR REPLACE VIEW dashboard_public.price_reductions AS
SELECT pc.article_id,
              CASE WHEN l.url ~ '^https?://(www\.)?olx\.ba/artikal/[0-9]+/?$'
            THEN l.url END AS url,
       l.title,
       pc.category_memberships,
       pc.category,
       pc.deal,
       pc.sqm,
       pc.rooms,
       COALESCE(NULLIF(l.location, ''),
                CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END) AS neighborhood,
       pc.prior_price,
       pc.price AS new_price,
       -pc.delta AS reduction_km,
       -pc.pct_change AS reduction_pct,
       pc.effective_at AS event_at,
       l.closed_at IS NULL AND l.last_seen > now() - INTERVAL '14 days' AS currently_observed,
       l.last_seen
  FROM v_listing_price_changes pc
  JOIN listings l ON l.article_id = pc.article_id
 WHERE pc.delta < 0;

-- One row per observed closure cycle.  Closure-time state is used instead of
-- today's listing attributes, so a reopened ad cannot erase or rewrite an
-- earlier exit.  A closing asking price is null when the last price evidence
-- at the boundary was invalid, conflicting, or unpriced.
CREATE OR REPLACE VIEW dashboard_public.exit_cycles AS
WITH closed AS (
  SELECT c.article_id, c.cycle_no, c.opened_at, c.closed_at,
         c.days_listed, l.title,
                CASE WHEN l.url ~ '^https?://(www\.)?olx\.ba/artikal/[0-9]+/?$'
              THEN l.url END AS url
    FROM v_listing_lifecycle_cycles c
    JOIN listings l ON l.article_id = c.article_id
   WHERE c.is_closed
),
state_at_close AS (
  SELECT c.*,
         s.category, s.category_membership, s.is_rent, s.sqm, s.rooms
    FROM closed c
    LEFT JOIN LATERAL (
      SELECT h.category, h.category_membership, h.is_rent, h.sqm, h.rooms
        FROM listing_state_history h
       WHERE h.article_id = c.article_id
         AND h.effective_at <= c.closed_at
         AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
       ORDER BY h.effective_at DESC, h.id DESC
       LIMIT 1
    ) s ON TRUE
),
price_at_close AS (
  SELECT s.*,
         p.price_state, p.price,
         CASE WHEN p.price_state = 'valid' AND p.price IS NOT NULL
                   AND s.is_rent = FALSE AND s.sqm BETWEEN 5 AND 500
                   AND p.price / NULLIF(s.sqm, 0) BETWEEN 1 AND 15000
              THEN round(p.price / NULLIF(s.sqm, 0))::int END AS asking_ppm2
    FROM state_at_close s
    LEFT JOIN LATERAL (
      SELECT e.price_state, e.price
        FROM listing_price_events e
       WHERE e.article_id = s.article_id
         AND e.effective_at <= s.closed_at
       ORDER BY e.effective_at DESC,
                CASE WHEN e.source IN ('search', 'detail') THEN 0 ELSE 1 END,
                CASE e.price_state WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                                    WHEN 'unpriced' THEN 2 ELSE 3 END,
                e.id DESC
       LIMIT 1
    ) p ON TRUE
)
SELECT article_id, cycle_no, title, url, opened_at, closed_at, days_listed,
       COALESCE(category_membership,
                CASE WHEN category IS NULL THEN '{}'::text[] ELSE ARRAY[category] END)
         AS category_memberships,
       category,
       CASE WHEN is_rent IS TRUE THEN 'rent'
            WHEN is_rent IS FALSE THEN 'sale'
            ELSE 'unknown' END AS deal,
       sqm, rooms,
       CASE WHEN price_state = 'valid' THEN price END AS last_asking_price,
       asking_ppm2 AS last_asking_ppm2,
       (cycle_no > 1) AS reopened_cycle
  FROM price_at_close;

CREATE OR REPLACE VIEW dashboard_public.freshness AS
SELECT COALESCE(NULLIF(ss.category, ''), '(unclassified)') AS category,
       count(*)::int AS configured_searches,
       max(r.finished_at) FILTER (
         WHERE r.status = 'ok' AND r.is_complete = TRUE AND r.finished_at IS NOT NULL
       ) AS last_success_at
  FROM saved_searches ss
  LEFT JOIN scrape_runs r ON r.search_key = ss.search_key
 GROUP BY 1;

COMMENT ON SCHEMA dashboard_public IS
  'Allowlisted, read-only reporting surface for externally shared Grafana dashboards.';
COMMENT ON VIEW dashboard_public.current_listings IS
  'Observed active OLX article IDs, deduplicated at article grain; current market fields only.';
COMMENT ON VIEW dashboard_public.daily_market IS
  'Reconstructed listing-day evidence with explicit deal and quality flags.';
COMMENT ON VIEW dashboard_public.price_reductions IS
  'Resolved valid-to-valid asking-price reductions; historical events are retained separately from current availability.';
COMMENT ON VIEW dashboard_public.exit_cycles IS
  'Observed closure cycles with attributes and asking price resolved at closure time; not confirmed transactions.';
COMMENT ON VIEW dashboard_public.freshness IS
  'Per-category completed successful scrape watermark; missing success remains NULL/unknown.';
