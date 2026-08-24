-- ─────────────────────────────────────────────────────────────────────────────
-- Fair-share enrichment scheduling.
--
-- listings.last_enrichment_attempted_at records when a row was last OFFERED
-- an enrichment pass (stamped by enrichListings() alongside details_fetched_at).
-- The per-run candidate pick orders on it — never-attempted rows first, then
-- oldest attempt — so a backlog larger than MAX_GEO_FETCHES rotates fairly
-- instead of re-picking the same head every cycle and starving rows whose
-- pin / m² olx.ba simply never provides.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_enrichment_attempted_at TIMESTAMPTZ;