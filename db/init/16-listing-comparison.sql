-- Shared private asking-price comparison contract, version 1.
-- No user selection enters the benchmark population.
CREATE OR REPLACE FUNCTION reporting.comparison_currency(p_currency text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN upper(btrim(p_currency)) IN ('KM', 'BAM') THEN 'BAM' END
$$;

CREATE OR REPLACE FUNCTION reporting.comparison_property_type(p_categories text[])
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN count(DISTINCT category) = 1
                   AND bool_and(coalesce(category IN ('apartments', 'houses', 'vacation_homes'),false))
              THEN min(category) END
    FROM unnest(p_categories) category
$$;

CREATE OR REPLACE FUNCTION reporting.comparison_price_reason(
  p_price numeric, p_state text, p_currency text, p_is_rent boolean)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_state IS NULL OR p_state = 'unknown' THEN 'Missing current price evidence'
    WHEN p_state = 'conflict' THEN 'Conflicting current price evidence'
    WHEN p_state = 'invalid' THEN 'Invalid current price'
    WHEN p_state = 'unpriced' THEN 'Unpriced current listing'
    WHEN p_state <> 'valid' OR p_price IS NULL OR p_price <= 0
      OR p_price::text IN ('NaN', 'Infinity', '-Infinity') THEN 'Invalid current price'
    WHEN reporting.comparison_currency(p_currency) IS NULL THEN 'Unknown or unsupported currency'
    WHEN p_is_rent IS NULL THEN 'Unknown deal segment'
    WHEN p_price < CASE WHEN p_is_rent THEN 50 ELSE 3000 END THEN 'Implausible asking price'
  END
$$;

CREATE OR REPLACE FUNCTION reporting.comparison_quality_reason(
  p_price numeric, p_state text, p_currency text, p_sqm numeric, p_is_rent boolean)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(reporting.comparison_price_reason(p_price,p_state,p_currency,p_is_rent),
    CASE WHEN p_sqm IS NULL THEN 'Missing area'
         WHEN p_sqm::text IN ('NaN', 'Infinity', '-Infinity') OR p_sqm NOT BETWEEN 5 AND 500
           THEN 'Invalid area'
         WHEN NOT p_is_rent AND round(p_price / nullif(p_sqm,0)) NOT BETWEEN 1 AND 15000
           THEN 'Implausible sale asking rate' END)
$$;

CREATE OR REPLACE FUNCTION reporting.numeric_bound(
  p_value text, p_label text, p_maximum numeric DEFAULT NULL)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE v numeric;
BEGIN
  IF nullif(btrim(p_value),'') IS NULL THEN RETURN NULL; END IF;
  IF length(btrim(p_value)) > 100 OR btrim(p_value) !~ '^[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION '% must be a non-negative decimal number, or blank', p_label;
  END IF;
  v := btrim(p_value)::numeric;
  IF p_maximum IS NOT NULL AND v > p_maximum THEN
    RAISE EXCEPTION '% must be between 0 and %', p_label, p_maximum;
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION reporting.within_bounds(
  p_value numeric, p_min text, p_max text, p_label text, p_maximum numeric DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE lo numeric := reporting.numeric_bound(p_min,p_label || ' minimum',p_maximum);
        hi numeric := reporting.numeric_bound(p_max,p_label || ' maximum',p_maximum);
BEGIN
  IF lo > hi THEN RAISE EXCEPTION '% minimum must not exceed maximum',p_label; END IF;
  RETURN (lo IS NULL OR coalesce(p_value >= lo,false))
     AND (hi IS NULL OR coalesce(p_value <= hi,false));
END $$;

CREATE OR REPLACE VIEW reporting.resolved_price_evidence AS
SELECT e.*, reporting.comparison_currency(e.provenance->>'currency') AS currency_normalized,
       CASE WHEN e.provenance ? 'dealType'
            THEN CASE e.provenance->>'dealType' WHEN 'sale' THEN false WHEN 'rent' THEN true END
            ELSE s.is_rent END AS evidence_is_rent
  FROM (
    SELECT DISTINCT ON (article_id,effective_at) * FROM listing_price_events
     WHERE effective_at <= now()
     ORDER BY article_id,effective_at,
       CASE WHEN source IN ('search','detail') THEN 0 ELSE 1 END,
       CASE price_state WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                        WHEN 'unpriced' THEN 2 ELSE 3 END, id DESC
  ) e
  LEFT JOIN LATERAL (
    SELECT h.is_rent FROM listing_state_history h
     WHERE h.article_id=e.article_id AND h.effective_at <= e.effective_at AND h.is_rent IS NOT NULL
     ORDER BY h.effective_at DESC,h.id DESC LIMIT 1
  ) s ON true;

CREATE OR REPLACE VIEW reporting.current_comparison_inputs AS
WITH evidence AS (
  SELECT l.article_id,l.url,l.title,l.sqm,l.rooms,l.is_rent,
         CASE WHEN l.is_rent THEN 'rent' ELSE 'sale' END AS deal,
         l.latitude,l.longitude,l.first_seen,l.last_seen,l.seller_type,
         l.condition,l.parking,l.garage,l.elevator,l.heating,l.floor_num,
         l.plot_sqm,l.year_built,l.bathrooms,l.rooms_detail,
         CASE WHEN furnishing.found THEN furnishing.value ELSE l.furnished END AS furnished,
         types.category_memberships,
         reporting.comparison_property_type(types.category_memberships) AS property_type,
         n.name AS neighborhood,
         CASE WHEN l.rooms ~ '^[0-9]+[+]?$'
              THEN CASE WHEN split_part(l.rooms,'+',1)::numeric>=4 THEN '4+' ELSE l.rooms END END AS room_bucket,
         p.price AS resolved_price,coalesce(p.price_state,'unknown') AS price_state,
         p.currency_normalized AS currency,p.effective_at AS price_effective_at,
         p.evidence_is_rent,
         cycle.opened_at AS cycle_opened_at,
         CASE WHEN cycle.opened_at IS NOT NULL
           THEN floor(extract(epoch FROM (now()-cycle.opened_at))/86400)::int END AS current_cycle_age_days,
         coalesce(cycle.cycle_no > 1,false) AS reopened,
         now() AS benchmark_at,1::int AS score_version
    FROM reporting.current_listings l
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT ss.category ORDER BY ss.category) AS category_memberships
        FROM search_results sr JOIN saved_searches ss USING(search_key)
       WHERE sr.article_id=l.article_id
    ) types ON true
    LEFT JOIN neighborhoods n ON n.name=coalesce(nullif(l.location,''),neighborhood_of(l.latitude,l.longitude))
    LEFT JOIN LATERAL (
      SELECT e.* FROM reporting.resolved_price_evidence e WHERE e.article_id=l.article_id
       ORDER BY e.effective_at DESC LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT true AS found,
             CASE h.filter_attributes->>'furnished' WHEN 'true' THEN true WHEN 'false' THEN false END AS value
        FROM listing_state_history h
       WHERE h.article_id=l.article_id AND h.effective_at <= now()
         AND h.filter_attributes ? 'furnished'
       ORDER BY h.effective_at DESC,h.id DESC LIMIT 1
    ) furnishing ON true
    LEFT JOIN LATERAL (
      SELECT c.* FROM v_listing_lifecycle_cycles c
       WHERE c.article_id=l.article_id AND c.opened_at <= now()
       ORDER BY c.opened_at DESC,c.cycle_no DESC LIMIT 1
    ) cycle ON cycle.closed_at IS NULL
), quality AS (
  SELECT e.*,
    coalesce(CASE WHEN e.evidence_is_rent IS DISTINCT FROM e.is_rent AND e.price_state='valid'
                    THEN 'Price evidence belongs to another or unknown deal segment' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM listing_state_history h WHERE h.article_id=e.article_id
          AND h.effective_at > e.price_effective_at AND h.effective_at <= now()
          AND h.is_rent IS DISTINCT FROM e.is_rent AND h.is_rent IS NOT NULL
      ) THEN 'Price evidence predates a deal switch' END,
      reporting.comparison_price_reason(e.resolved_price,e.price_state,e.currency,e.is_rent)) AS price_reason
  FROM evidence e
), eligible AS (
  SELECT q.*,
    CASE WHEN price_reason IS NULL THEN resolved_price END AS asking_price,
    CASE WHEN price_reason IS NULL AND reporting.comparison_quality_reason(
      resolved_price,price_state,currency,sqm,is_rent) IS NULL
      THEN resolved_price / sqm END AS asking_rate,
    coalesce(price_reason,reporting.comparison_quality_reason(resolved_price,price_state,currency,sqm,is_rent),
      CASE WHEN neighborhood IS NULL THEN 'Missing mapped neighbourhood'
           WHEN property_type IS NULL THEN 'Unknown or ambiguous property type'
           WHEN room_bucket IS NULL THEN 'Missing or unsupported room bucket'
           WHEN is_rent AND furnished IS NULL THEN 'Unknown or partial furnishing' END) AS score_input_reason
  FROM quality q
)
SELECT * FROM eligible;

CREATE OR REPLACE FUNCTION reporting.listing_comparables(p_article_id bigint)
RETURNS SETOF reporting.current_comparison_inputs LANGUAGE sql STABLE AS $$
  WITH inputs AS MATERIALIZED (SELECT * FROM reporting.current_comparison_inputs)
  SELECT c.* FROM inputs t JOIN inputs c ON c.article_id<>t.article_id
    AND c.neighborhood=t.neighborhood AND c.property_type=t.property_type
    AND c.is_rent=t.is_rent AND c.room_bucket=t.room_bucket
    AND c.sqm BETWEEN t.sqm*0.8 AND t.sqm*1.2
    AND (NOT t.is_rent OR c.furnished=t.furnished)
   WHERE t.article_id=p_article_id AND t.score_input_reason IS NULL AND c.score_input_reason IS NULL
   ORDER BY c.article_id
$$;

CREATE OR REPLACE VIEW reporting.comparison_price_changes AS
WITH ordered AS (
  SELECT e.*,lag(price) OVER w AS prior_price,lag(price_state) OVER w AS prior_state,
    lag(currency_normalized) OVER w AS prior_currency,
    lag(evidence_is_rent) OVER w AS prior_is_rent,lag(effective_at) OVER w AS prior_effective_at
    FROM reporting.resolved_price_evidence e
    WINDOW w AS (PARTITION BY article_id ORDER BY effective_at,id)
)
SELECT e.article_id,e.effective_at,e.prior_effective_at,e.prior_price,e.price,
       e.price-e.prior_price AS delta,100*(e.price-e.prior_price)/e.prior_price AS pct_change,
       CASE WHEN e.evidence_is_rent THEN 'rent' ELSE 'sale' END AS deal,e.currency_normalized AS currency
  FROM ordered e JOIN reporting.current_comparison_inputs l USING(article_id)
 WHERE e.effective_at >= l.cycle_opened_at AND e.prior_effective_at >= l.cycle_opened_at
   AND e.evidence_is_rent=l.is_rent AND e.prior_is_rent=e.evidence_is_rent
   AND reporting.comparison_price_reason(e.price,e.price_state,e.currency_normalized,e.evidence_is_rent) IS NULL
   AND reporting.comparison_price_reason(e.prior_price,e.prior_state,e.prior_currency,e.prior_is_rent) IS NULL
   AND e.price<>e.prior_price
   AND NOT EXISTS (SELECT 1 FROM listing_state_history h WHERE h.article_id=e.article_id
     AND h.effective_at > e.prior_effective_at AND h.effective_at <= e.effective_at
     AND h.is_rent IS NOT NULL AND h.is_rent<>e.evidence_is_rent);

CREATE OR REPLACE VIEW reporting.current_listing_scores AS
WITH inputs AS MATERIALIZED (SELECT * FROM reporting.current_comparison_inputs),
changes AS MATERIALIZED (SELECT * FROM reporting.comparison_price_changes),
cohorts AS (
  SELECT t.*,a.comparable_count,
    CASE WHEN a.comparable_count>=10 THEN a.median END AS benchmark_rate,
    CASE WHEN a.comparable_count>=10 THEN a.p25 END AS benchmark_p25,
    CASE WHEN a.comparable_count>=10 THEN a.p75 END AS benchmark_p75
  FROM inputs t LEFT JOIN LATERAL (
    SELECT count(*)::int AS comparable_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c.asking_rate)::numeric AS median,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY c.asking_rate)::numeric AS p25,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY c.asking_rate)::numeric AS p75
    FROM inputs c WHERE t.score_input_reason IS NULL AND c.score_input_reason IS NULL
      AND c.article_id<>t.article_id AND c.neighborhood=t.neighborhood
      AND c.property_type=t.property_type AND c.is_rent=t.is_rent AND c.room_bucket=t.room_bucket
      AND c.sqm BETWEEN t.sqm*0.8 AND t.sqm*1.2 AND (NOT t.is_rent OR c.furnished=t.furnished)
  ) a ON true
), deviations AS (
  SELECT c.*,100*(asking_rate/benchmark_rate-1) AS deviation_pct,
    coalesce(score_input_reason,CASE WHEN comparable_count<10 THEN 'Insufficient comparables' END) AS unscored_reason,
    CASE WHEN comparable_count>=20 THEN 'Larger sample' WHEN comparable_count>=10 THEN 'Limited sample'
         ELSE 'Insufficient comparables' END AS confidence
  FROM cohorts c
)
SELECT d.*,CASE WHEN deviation_pct IS NOT NULL THEN round(greatest(0,least(100,50-deviation_pct)))::int END AS score,
  CASE WHEN deviation_pct < -10 THEN 'Well below local asking benchmark'
       WHEN deviation_pct < -5 THEN 'Below local asking benchmark'
       WHEN deviation_pct <= 5 THEN 'Near local asking benchmark'
       WHEN deviation_pct <= 10 THEN 'Above local asking benchmark'
       WHEN deviation_pct > 10 THEN 'Well above local asking benchmark' END AS position_label,
  benchmark_rate*sqm AS indicative_total,benchmark_p25*sqm AS indicative_low,benchmark_p75*sqm AS indicative_high,
  asking_price-benchmark_rate*sqm AS asking_gap_km,
  reduction.effective_at AS latest_reduction_at,-reduction.delta AS reduction_km,-reduction.pct_change AS reduction_pct
  FROM deviations d LEFT JOIN LATERAL (
    SELECT pc.* FROM changes pc
     WHERE pc.article_id=d.article_id AND pc.delta<0 AND pc.price=d.asking_price
       AND NOT EXISTS (
         SELECT 1 FROM reporting.resolved_price_evidence e
          WHERE e.article_id=d.article_id AND e.effective_at>pc.effective_at
            AND (e.price_state<>'valid' OR e.price IS DISTINCT FROM pc.price
                 OR e.currency_normalized IS DISTINCT FROM 'BAM' OR e.evidence_is_rent IS DISTINCT FROM d.is_rent)
       )
       AND NOT EXISTS (
         SELECT 1 FROM listing_state_history h WHERE h.article_id=d.article_id
           AND h.effective_at>pc.effective_at AND h.effective_at<=now()
           AND h.is_rent IS NOT NULL AND h.is_rent<>d.is_rent
       )
     ORDER BY pc.effective_at DESC LIMIT 1
  ) reduction ON true;

COMMENT ON VIEW reporting.current_listing_scores IS
  'Version 1 local asking-price score; now and 14-day active inventory; unfiltered same-location/type/deal/room/size cohort, same known furnishing for rent. Not an appraisal.';
COMMENT ON FUNCTION reporting.comparison_quality_reason(numeric,text,text,numeric,boolean) IS
  'Sale: existing minimum 3000 BAM, area 5..500, rounded rate 1..15000. Monthly rental quality v1: minimum 50 BAM/month, area 5..500, positive rate; no sale rate threshold or invented rental upper bound.';

-- Private role grants and function ownership are applied by zz-database-roles.sh.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reporting FROM PUBLIC;
