-- Older untracked databases may already have the initial listings table when
-- this directory is first applied. Add its later nullable columns before the
-- current indexes and views in 01-schema.sql are created.
DO $$
BEGIN
  IF to_regclass('public.listings') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE listings ADD COLUMN IF NOT EXISTS location TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS closing_price NUMERIC(12,2);
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS closing_ppm2 INTEGER;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS closing_category TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS renewed_at TIMESTAMPTZ;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_type TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS rooms_detail TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS bathrooms SMALLINT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor_num SMALLINT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS floors_total SMALLINT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS unit_levels SMALLINT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS heating TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS furnished BOOLEAN;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS condition TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS parking BOOLEAN;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS garage BOOLEAN;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS elevator BOOLEAN;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS year_built SMALLINT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS plot_sqm NUMERIC(8,2);
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS orientation TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS views INTEGER;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS favorites INTEGER;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS characteristics JSONB;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS api_price_history JSONB;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS api_status TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS details_fetched_at TIMESTAMPTZ;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_enrichment_attempted_at TIMESTAMPTZ;
END
$$;
