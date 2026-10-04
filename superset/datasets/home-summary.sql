-- Cached 10-minute reproduction of the source Home KPI query.
WITH a AS (
  SELECT count(*) FILTER (WHERE closed_at IS NULL) AS active,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
      FILTER (WHERE closed_at IS NULL AND deal='sale' AND ppm2>0) AS sale_ppm2,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
      FILTER (WHERE closed_at IS NULL AND deal='rent' AND price>0) AS rent_price,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
      FILTER (WHERE closed_at IS NULL AND deal='sale' AND price>0) AS sale_price,
    count(*) FILTER (WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30) AS recent_exits,
    count(*) FILTER (WHERE closed_at IS NULL OR closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30) AS recent_population,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
      FILTER (WHERE deal='sale' AND ppm2>0 AND first_seen >= date_trunc('week', now())) AS current_week,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
      FILTER (WHERE deal='sale' AND ppm2>0 AND first_seen >= date_trunc('week', now()) - INTERVAL '7 days'
        AND first_seen < date_trunc('week', now())) AS prior_week
  FROM lean.listings
)
SELECT active,
  round(sale_ppm2::numeric,0) AS median_sale_ppm2,
  round(rent_price::numeric,0) AS median_monthly_rent_bam,
  round((1200 * rent_price / NULLIF(sale_price,0))::numeric,1) AS gross_yield_pct,
  round(100.0 * recent_exits / NULLIF(recent_population,0),1) AS observed_exit_ratio_pct,
  round((100 * (current_week / NULLIF(prior_week,0) - 1))::numeric,1) AS new_sale_ppm2_change_pct
FROM a
