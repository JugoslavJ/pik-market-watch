-- Private historical evidence for the buyer, renter, and agent personas.
--
-- A daily row is evaluated from the price assertion and listing state that
-- produced that day.  Do not use listings here: its attributes are current
-- and would rewrite the historical population after an edit or reopening.
-- Currency is assertion provenance, so pre-currency evidence intentionally
-- remains visible but is ineligible for price aggregates.

CREATE OR REPLACE VIEW reporting.daily_listing_facts AS
WITH evidence AS (
  SELECT d.*,
         p.currency_normalized AS currency,
         p.evidence_is_rent,
         ARRAY(
           SELECT DISTINCT member FROM unnest(
             COALESCE(d.category_memberships, '{}'::text[])
             || CASE WHEN NULLIF(btrim(d.category), '') IS NULL THEN '{}'::text[]
                     ELSE ARRAY[d.category] END) members(member)
            WHERE member IS NOT NULL AND member <> '' ORDER BY member) AS resolved_category_memberships,
         reporting.comparison_property_type(ARRAY(
           SELECT DISTINCT member FROM unnest(
             COALESCE(d.category_memberships, '{}'::text[])
             || CASE WHEN NULLIF(btrim(d.category), '') IS NULL THEN '{}'::text[]
                     ELSE ARRAY[d.category] END) members(member)
            WHERE member IS NOT NULL AND member <> '' ORDER BY member)) AS property_type
    FROM v_listing_daily d
    LEFT JOIN reporting.resolved_price_evidence p
      ON p.article_id = d.article_id
     AND p.effective_at = d.price_effective_at
), quality AS (
  SELECT e.*,
         CASE
           WHEN e.price_effective_at IS NOT NULL
            AND e.evidence_is_rent IS DISTINCT FROM e.is_rent
             THEN 'price evidence belongs to another deal'
           WHEN e.price_effective_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM listing_state_history h
              WHERE h.article_id = e.article_id
                AND h.effective_at > e.price_effective_at
                AND h.effective_at < analytics_sarajevo_day_start(e.day + 1)
                AND h.is_rent IS NOT NULL
                AND h.is_rent IS DISTINCT FROM e.evidence_is_rent)
             THEN 'price evidence predates a deal switch'
           ELSE reporting.comparison_price_reason(
             e.price, e.price_state, e.currency, e.is_rent)
         END AS price_quality_reason,
         CASE
           WHEN e.price_effective_at IS NOT NULL
            AND e.evidence_is_rent IS DISTINCT FROM e.is_rent
             THEN 'price evidence belongs to another deal'
           WHEN e.price_effective_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM listing_state_history h
              WHERE h.article_id = e.article_id
                AND h.effective_at > e.price_effective_at
                AND h.effective_at < analytics_sarajevo_day_start(e.day + 1)
                AND h.is_rent IS NOT NULL
                AND h.is_rent IS DISTINCT FROM e.evidence_is_rent)
             THEN 'price evidence predates a deal switch'
           ELSE reporting.comparison_quality_reason(
             e.price, e.price_state, e.currency, e.sqm, e.is_rent)
         END AS rate_quality_reason
    FROM evidence e
)
SELECT q.day, q.article_id, q.title, q.url,
       q.category, q.resolved_category_memberships AS category_memberships, q.is_rent,
       CASE WHEN q.is_rent IS TRUE THEN 'rent'
            WHEN q.is_rent IS FALSE THEN 'sale'
            ELSE 'unknown' END AS deal,
       q.rooms, q.sqm, q.location, q.neighborhood,
       q.price, q.price_state, q.ppm2,
       q.state_effective_at, q.price_effective_at,
       q.membership_inferred, q.attributes_inferred,
       q.stale_observation, q.provisional_day,
       q.filter_attributes,
       q.property_type, room_bucket(q.rooms) AS room_bucket, q.currency,
       q.filter_attributes AS historical_attributes,
       NULLIF(COALESCE(q.filter_attributes->>'sellerType',
                        q.filter_attributes->'searchAttributes'->>'sellerType'), '')
         AS historical_seller_type,
       NULLIF(COALESCE(q.filter_attributes->>'condition',
                        q.filter_attributes->'searchAttributes'->>'condition'), '')
         AS historical_condition,
       CASE lower(COALESCE(q.filter_attributes->>'furnished',
                           q.filter_attributes->'searchAttributes'->>'furnished', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL
       END AS historical_furnished,
       NULLIF(COALESCE(q.filter_attributes->>'heating',
                        q.filter_attributes->'searchAttributes'->>'heating'), '')
         AS historical_heating,
       CASE lower(COALESCE(q.filter_attributes->>'parking',
                           q.filter_attributes->'searchAttributes'->>'parking', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL
       END AS historical_parking,
       CASE lower(COALESCE(q.filter_attributes->>'garage',
                           q.filter_attributes->'searchAttributes'->>'garage', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL
       END AS historical_garage,
       CASE lower(COALESCE(q.filter_attributes->>'elevator',
                           q.filter_attributes->'searchAttributes'->>'elevator', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL
       END AS historical_elevator,
       CASE WHEN COALESCE(q.filter_attributes->>'floorNum',
                          q.filter_attributes->'searchAttributes'->>'floorNum') ~ '^-?[0-9]{1,5}$'
              AND COALESCE(q.filter_attributes->>'floorNum',
                           q.filter_attributes->'searchAttributes'->>'floorNum')::numeric
                    BETWEEN -32768 AND 32767
            THEN COALESCE(q.filter_attributes->>'floorNum',
                          q.filter_attributes->'searchAttributes'->>'floorNum')::smallint END
         AS historical_floor_num,
       q.price_quality_reason,
       q.rate_quality_reason,
       (q.price_quality_reason IS NULL) AS price_eligible,
       (q.rate_quality_reason IS NULL) AS rate_eligible,
       CASE WHEN q.price_quality_reason IS NULL THEN q.price END AS asking_price,
       CASE WHEN q.rate_quality_reason IS NULL
            THEN q.price / NULLIF(q.sqm, 0) END AS asking_rate,
       CASE WHEN q.is_rent IS TRUE THEN 'KM/month'
            WHEN q.is_rent IS FALSE THEN 'KM'
            ELSE NULL END AS asking_price_unit,
       CASE WHEN q.is_rent IS TRUE THEN 'KM/m²/month'
            WHEN q.is_rent IS FALSE THEN 'KM/m²'
            ELSE NULL END AS asking_rate_unit
  FROM quality q;

COMMENT ON VIEW reporting.daily_listing_facts IS
  'One reconstructed Sarajevo listing-day per article. asking_price and asking_rate are separately eligible historical samples; historical_attributes and quality flags are recorded/inferred at that day, never copied from the current listing.';

-- One row per observed opening/reopening cycle.  The closure state is frozen
-- from records no later than closed_at; a later reopening cannot change it.
CREATE OR REPLACE VIEW reporting.lifecycle_cycles AS
WITH cycle_states AS (
  SELECT c.article_id, c.cycle_no, c.opened_at, c.closed_at, c.is_closed,
         c.days_listed AS observed_cycle_duration_days,
         od.category AS opening_direct_category,
         od.category_membership AS opening_direct_memberships,
         od.is_rent AS opening_direct_is_rent,
         od.sqm AS opening_direct_sqm, od.rooms AS opening_direct_rooms,
         od.filter_attributes AS opening_direct_attributes,
         od.membership_inferred AS opening_direct_membership_inferred,
         od.attributes_inferred AS opening_direct_attributes_inferred,
         os.category AS opening_history_category,
         os.memberships AS opening_history_memberships,
         os.is_rent AS opening_history_is_rent, os.sqm AS opening_history_sqm,
         os.rooms AS opening_history_rooms, os.attributes AS opening_history_attributes,
         cd.category AS closing_direct_category,
         cd.category_membership AS closing_direct_memberships,
         cd.is_rent AS closing_direct_is_rent,
         cd.sqm AS closing_direct_sqm, cd.rooms AS closing_direct_rooms,
         cd.filter_attributes AS closing_direct_attributes,
         cd.membership_inferred AS closing_direct_membership_inferred,
         cd.attributes_inferred AS closing_direct_attributes_inferred,
         cs.category AS closing_history_category,
         cs.memberships AS closing_history_memberships,
         cs.is_rent AS closing_history_is_rent, cs.sqm AS closing_history_sqm,
         cs.rooms AS closing_history_rooms, cs.attributes AS closing_history_attributes
    FROM v_listing_lifecycle_cycles c
    LEFT JOIN LATERAL (
      SELECT h.* FROM listing_state_history h
       WHERE h.article_id = c.article_id AND h.effective_at = c.opened_at
         AND h.event_type IN ('search_sighting', 'reopened')
       ORDER BY h.id DESC LIMIT 1
    ) od ON true
    LEFT JOIN LATERAL (
      SELECT fields.*, memberships.memberships, attributes.attributes
        FROM LATERAL (
          SELECT
            (array_agg(h.category ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE NULLIF(btrim(h.category), '') IS NOT NULL))[1] AS category,
            (array_agg(h.is_rent ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE h.is_rent IS NOT NULL))[1] AS is_rent,
            (array_agg(h.sqm ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE h.sqm IS NOT NULL))[1] AS sqm,
            (array_agg(h.rooms ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE h.rooms IS NOT NULL))[1] AS rooms
            FROM listing_state_history h
           WHERE h.article_id = c.article_id AND h.effective_at <= c.opened_at
             AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
        ) fields
        CROSS JOIN LATERAL (
          SELECT COALESCE(array_agg(DISTINCT member ORDER BY member), '{}'::text[]) AS memberships
            FROM listing_state_history h CROSS JOIN LATERAL unnest(h.category_membership) members(member)
           WHERE h.article_id = c.article_id AND h.effective_at <= c.opened_at
             AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
             AND member IS NOT NULL AND member <> ''
        ) memberships
        CROSS JOIN LATERAL (
          SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb) AS attributes
            FROM (
              SELECT DISTINCT ON (attrs.key) attrs.key, attrs.value
                FROM listing_state_history h
                CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(h.filter_attributes) = 'object'
                                                    THEN h.filter_attributes ELSE '{}'::jsonb END) attrs(key, value)
               WHERE h.article_id = c.article_id AND h.effective_at <= c.opened_at
                 AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
               ORDER BY attrs.key, h.effective_at DESC, h.id DESC
            ) a
        ) attributes
    ) os ON true
    LEFT JOIN LATERAL (
      SELECT h.* FROM listing_state_history h
       WHERE h.article_id = c.article_id AND h.effective_at = c.closed_at
         AND h.event_type = 'closed'
       ORDER BY h.id DESC LIMIT 1
    ) cd ON true
    LEFT JOIN LATERAL (
      SELECT fields.*, memberships.memberships, attributes.attributes
        FROM LATERAL (
          SELECT
            (array_agg(h.category ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE NULLIF(btrim(h.category), '') IS NOT NULL))[1] AS category,
            (array_agg(h.is_rent ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE h.is_rent IS NOT NULL))[1] AS is_rent,
            (array_agg(h.sqm ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE h.sqm IS NOT NULL))[1] AS sqm,
            (array_agg(h.rooms ORDER BY h.effective_at DESC, h.id DESC)
              FILTER (WHERE h.rooms IS NOT NULL))[1] AS rooms
            FROM listing_state_history h
           WHERE h.article_id = c.article_id AND h.effective_at < c.closed_at
             AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
        ) fields
        CROSS JOIN LATERAL (
          SELECT COALESCE(array_agg(DISTINCT member ORDER BY member), '{}'::text[]) AS memberships
            FROM listing_state_history h CROSS JOIN LATERAL unnest(h.category_membership) members(member)
           WHERE h.article_id = c.article_id AND h.effective_at < c.closed_at
             AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
             AND member IS NOT NULL AND member <> ''
        ) memberships
        CROSS JOIN LATERAL (
          SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb) AS attributes
            FROM (
              SELECT DISTINCT ON (attrs.key) attrs.key, attrs.value
                FROM listing_state_history h
                CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(h.filter_attributes) = 'object'
                                                    THEN h.filter_attributes ELSE '{}'::jsonb END) attrs(key, value)
               WHERE h.article_id = c.article_id AND h.effective_at < c.closed_at
                 AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
               ORDER BY attrs.key, h.effective_at DESC, h.id DESC
            ) a
        ) attributes
    ) cs ON true
), frozen_states AS (
  SELECT s.*,
         COALESCE(s.opening_direct_category, s.opening_history_category) AS opening_category,
         ARRAY(SELECT DISTINCT member FROM unnest(COALESCE(s.opening_history_memberships, '{}'::text[])
           || COALESCE(s.opening_direct_memberships, '{}'::text[])
           || CASE WHEN COALESCE(s.opening_direct_category, s.opening_history_category) IS NULL
                   THEN '{}'::text[] ELSE ARRAY[COALESCE(s.opening_direct_category, s.opening_history_category)] END)
           members(member) WHERE member IS NOT NULL AND member <> '' ORDER BY member) AS opening_category_memberships,
         COALESCE(s.opening_direct_is_rent, s.opening_history_is_rent) AS opening_is_rent,
         COALESCE(s.opening_direct_sqm, s.opening_history_sqm) AS opening_sqm,
         COALESCE(s.opening_direct_rooms, s.opening_history_rooms) AS opening_rooms,
         COALESCE(s.opening_history_attributes, '{}'::jsonb) || COALESCE(s.opening_direct_attributes, '{}'::jsonb) AS opening_attributes,
         COALESCE(s.opening_direct_membership_inferred, false)
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(s.opening_history_memberships, '{}'::text[])) m(member)
                       WHERE NOT (m.member = ANY(COALESCE(s.opening_direct_memberships, '{}'::text[])))) AS opening_membership_inferred,
         COALESCE(s.opening_direct_attributes_inferred, false)
           OR (s.opening_direct_category IS NULL AND s.opening_history_category IS NOT NULL)
           OR (s.opening_direct_is_rent IS NULL AND s.opening_history_is_rent IS NOT NULL)
           OR (s.opening_direct_sqm IS NULL AND s.opening_history_sqm IS NOT NULL)
           OR (s.opening_direct_rooms IS NULL AND s.opening_history_rooms IS NOT NULL)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(s.opening_history_attributes, '{}'::jsonb)) a(key)
                       WHERE NOT (COALESCE(s.opening_direct_attributes, '{}'::jsonb) ? a.key)) AS opening_attributes_inferred,
         analytics_state_neighborhood(COALESCE(s.opening_history_attributes, '{}'::jsonb)
           || COALESCE(s.opening_direct_attributes, '{}'::jsonb)) AS opening_neighborhood,
         COALESCE(s.closing_direct_category, s.closing_history_category) AS closing_category,
         ARRAY(SELECT DISTINCT member FROM unnest(COALESCE(s.closing_history_memberships, '{}'::text[])
           || COALESCE(s.closing_direct_memberships, '{}'::text[])
           || CASE WHEN COALESCE(s.closing_direct_category, s.closing_history_category) IS NULL
                   THEN '{}'::text[] ELSE ARRAY[COALESCE(s.closing_direct_category, s.closing_history_category)] END)
           members(member) WHERE member IS NOT NULL AND member <> '' ORDER BY member) AS closing_category_memberships,
         COALESCE(s.closing_direct_is_rent, s.closing_history_is_rent) AS closing_is_rent,
         COALESCE(s.closing_direct_sqm, s.closing_history_sqm) AS closing_sqm,
         COALESCE(s.closing_direct_rooms, s.closing_history_rooms) AS closing_rooms,
         COALESCE(s.closing_history_attributes, '{}'::jsonb) || COALESCE(s.closing_direct_attributes, '{}'::jsonb) AS closing_attributes,
         COALESCE(s.closing_direct_membership_inferred, false)
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(s.closing_history_memberships, '{}'::text[])) m(member)
                       WHERE NOT (m.member = ANY(COALESCE(s.closing_direct_memberships, '{}'::text[])))) AS closing_membership_inferred,
         COALESCE(s.closing_direct_attributes_inferred, false)
           OR (s.closing_direct_category IS NULL AND s.closing_history_category IS NOT NULL)
           OR (s.closing_direct_is_rent IS NULL AND s.closing_history_is_rent IS NOT NULL)
           OR (s.closing_direct_sqm IS NULL AND s.closing_history_sqm IS NOT NULL)
           OR (s.closing_direct_rooms IS NULL AND s.closing_history_rooms IS NOT NULL)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(s.closing_history_attributes, '{}'::jsonb)) a(key)
                       WHERE NOT (COALESCE(s.closing_direct_attributes, '{}'::jsonb) ? a.key)) AS closing_attributes_inferred,
         analytics_state_neighborhood(COALESCE(s.closing_history_attributes, '{}'::jsonb)
           || COALESCE(s.closing_direct_attributes, '{}'::jsonb)) AS closing_neighborhood
    FROM cycle_states s
), priced AS (
  SELECT f.*, p.effective_at AS closing_price_effective_at,
         p.price AS closing_observed_price,
         COALESCE(p.price_state, 'unknown') AS closing_price_state,
         p.currency_normalized AS closing_currency,
         p.evidence_is_rent AS closing_price_is_rent
    FROM frozen_states f
    LEFT JOIN LATERAL (
      SELECT e.* FROM reporting.resolved_price_evidence e
       WHERE e.article_id = f.article_id
         AND f.closed_at IS NOT NULL
         AND e.effective_at <= f.closed_at
       ORDER BY e.effective_at DESC, e.id DESC
       LIMIT 1
    ) p ON true
), quality AS (
  SELECT p.*,
         reporting.comparison_property_type(p.opening_category_memberships) AS opening_property_type,
         reporting.comparison_property_type(p.closing_category_memberships) AS closing_property_type,
         CASE
           WHEN p.closing_price_effective_at IS NOT NULL
            AND p.closing_price_is_rent IS DISTINCT FROM p.closing_is_rent
             THEN 'price evidence belongs to another deal'
           WHEN p.closing_price_effective_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM listing_state_history h
              WHERE h.article_id = p.article_id
                AND h.effective_at > p.closing_price_effective_at
                AND h.effective_at <= p.closed_at
                AND h.is_rent IS NOT NULL
                AND h.is_rent IS DISTINCT FROM p.closing_price_is_rent)
             THEN 'price evidence predates a deal switch'
           ELSE reporting.comparison_price_reason(
             p.closing_observed_price, p.closing_price_state,
             p.closing_currency, p.closing_is_rent)
         END AS closing_price_quality_reason,
         CASE
           WHEN p.closing_price_effective_at IS NOT NULL
            AND p.closing_price_is_rent IS DISTINCT FROM p.closing_is_rent
             THEN 'price evidence belongs to another deal'
           WHEN p.closing_price_effective_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM listing_state_history h
              WHERE h.article_id = p.article_id
                AND h.effective_at > p.closing_price_effective_at
                AND h.effective_at <= p.closed_at
                AND h.is_rent IS NOT NULL
                AND h.is_rent IS DISTINCT FROM p.closing_price_is_rent)
             THEN 'price evidence predates a deal switch'
           ELSE reporting.comparison_quality_reason(
             p.closing_observed_price, p.closing_price_state,
             p.closing_currency, p.closing_sqm, p.closing_is_rent)
         END AS closing_rate_quality_reason
    FROM priced p
)
SELECT q.article_id, q.cycle_no, q.opened_at,
       (q.opened_at AT TIME ZONE 'Europe/Sarajevo')::date AS opened_day,
       q.closed_at,
       CASE WHEN q.closed_at IS NULL THEN NULL
            ELSE (q.closed_at AT TIME ZONE 'Europe/Sarajevo')::date END AS closed_day,
       q.is_closed, (q.cycle_no > 1) AS reopened_cycle,
       q.observed_cycle_duration_days,
       CASE WHEN q.closed_at IS NULL AND q.opened_at IS NOT NULL
            THEN greatest(round(extract(epoch FROM (now() - q.opened_at)) / 86400.0)::int, 0)
            ELSE NULL END AS current_cycle_age_days,
       q.opening_category, q.opening_category_memberships,
       CASE WHEN q.opening_is_rent IS TRUE THEN 'rent'
            WHEN q.opening_is_rent IS FALSE THEN 'sale'
            ELSE 'unknown' END AS opening_deal,
       q.opening_property_type, q.opening_sqm, q.opening_rooms,
       room_bucket(q.opening_rooms) AS opening_room_bucket,
       q.opening_neighborhood,
       q.opening_attributes, q.opening_membership_inferred,
       q.opening_attributes_inferred,
       q.closing_category, q.closing_category_memberships,
       CASE WHEN q.closing_is_rent IS TRUE THEN 'rent'
            WHEN q.closing_is_rent IS FALSE THEN 'sale'
            ELSE 'unknown' END AS closing_deal,
       q.closing_property_type, q.closing_sqm, q.closing_rooms,
       room_bucket(q.closing_rooms) AS closing_room_bucket,
       q.closing_neighborhood,
       q.closing_attributes, q.closing_membership_inferred,
       q.closing_attributes_inferred,
       q.closing_price_effective_at, q.closing_price_state,
       q.closing_currency, q.closing_observed_price,
       q.closing_price_quality_reason, q.closing_rate_quality_reason,
       (q.closing_price_quality_reason IS NULL) AS closing_price_eligible,
       (q.closing_rate_quality_reason IS NULL) AS closing_rate_eligible,
       CASE WHEN q.closing_price_quality_reason IS NULL
            THEN q.closing_observed_price END AS final_asking_price,
       CASE WHEN q.closing_rate_quality_reason IS NULL
            THEN q.closing_observed_price / NULLIF(q.closing_sqm, 0) END
         AS final_asking_rate,
       CASE WHEN q.closing_is_rent IS TRUE THEN 'KM/month'
            WHEN q.closing_is_rent IS FALSE THEN 'KM'
            ELSE NULL END AS final_asking_price_unit,
       CASE WHEN q.closing_is_rent IS TRUE THEN 'KM/m²/month'
            WHEN q.closing_is_rent IS FALSE THEN 'KM/m²'
            ELSE NULL END AS final_asking_rate_unit
  FROM quality q;

COMMENT ON VIEW reporting.lifecycle_cycles IS
  'One row per observed opening/reopening cycle. Closure fields are frozen from evidence no later than closed_at; final asking values have independent eligibility and do not use current listing scores or attributes.';

CREATE OR REPLACE VIEW reporting.lifecycle_movements AS
WITH movement_rows AS (
SELECT CASE WHEN c.reopened_cycle THEN 'reopening' ELSE 'first_observation' END AS movement_type,
       c.opened_at AS event_at, c.opened_day AS event_day,
       c.article_id, c.cycle_no, c.reopened_cycle,
       c.opening_deal AS deal, c.opening_property_type AS property_type,
       c.opening_category AS category,
       c.opening_category_memberships AS category_memberships,
       c.opening_sqm AS sqm, c.opening_rooms AS rooms,
       c.opening_room_bucket AS room_bucket,
       c.opening_neighborhood AS neighborhood,
       c.opening_attributes AS historical_attributes,
       c.opening_membership_inferred AS membership_inferred,
       c.opening_attributes_inferred AS attributes_inferred,
       NULL::text AS price_state, NULL::text AS currency,
       NULL::numeric AS asking_price, NULL::numeric AS asking_rate,
       NULL::boolean AS price_eligible, NULL::boolean AS rate_eligible
  FROM reporting.lifecycle_cycles c
UNION ALL
SELECT 'closure', c.closed_at, c.closed_day,
       c.article_id, c.cycle_no, c.reopened_cycle,
       c.closing_deal, c.closing_property_type, c.closing_category,
       c.closing_category_memberships, c.closing_sqm, c.closing_rooms,
       c.closing_room_bucket, c.closing_neighborhood,
       c.closing_attributes,
       c.closing_membership_inferred, c.closing_attributes_inferred,
       c.closing_price_state, c.closing_currency,
       c.final_asking_price, c.final_asking_rate,
       c.closing_price_eligible, c.closing_rate_eligible
  FROM reporting.lifecycle_cycles c
 WHERE c.is_closed
)
SELECT m.*,
       NULLIF(m.historical_attributes->>'sellerType', '') AS historical_seller_type,
       NULLIF(m.historical_attributes->>'condition', '') AS historical_condition,
       CASE lower(COALESCE(m.historical_attributes->>'furnished', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL END AS historical_furnished,
       NULLIF(m.historical_attributes->>'heating', '') AS historical_heating,
       CASE lower(COALESCE(m.historical_attributes->>'parking', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL END AS historical_parking,
       CASE lower(COALESCE(m.historical_attributes->>'garage', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL END AS historical_garage,
       CASE lower(COALESCE(m.historical_attributes->>'elevator', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL END AS historical_elevator,
       CASE WHEN m.historical_attributes->>'floorNum' ~ '^-?[0-9]{1,5}$'
              AND (m.historical_attributes->>'floorNum')::numeric BETWEEN -32768 AND 32767
            THEN (m.historical_attributes->>'floorNum')::smallint END AS historical_floor_num
  FROM movement_rows m;

COMMENT ON VIEW reporting.lifecycle_movements IS
  'Event-time supply movements at article-cycle grain. Closure rows come only from closed lifecycle cycles; score filters never select this historical population.';
