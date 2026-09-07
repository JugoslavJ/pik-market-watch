-- Publication evidence is normalized independently of the expiring raw archive.

CREATE TABLE IF NOT EXISTS listing_publication_evidence (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id     BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  published_at   TIMESTAMPTZ NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         TEXT NOT NULL,
  evidence_kind  TEXT NOT NULL DEFAULT 'upstream_created_at',
  UNIQUE (article_id, published_at, source)
);

CREATE INDEX IF NOT EXISTS listing_publication_evidence_article_idx
  ON listing_publication_evidence (article_id, published_at);

CREATE TABLE IF NOT EXISTS publication_evidence_transition (
  id              SMALLINT PRIMARY KEY CHECK (id = 1),
  last_raw_id     BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  recoverable     BIGINT NOT NULL DEFAULT 0,
  imported        BIGINT NOT NULL DEFAULT 0,
  conflicting     BIGINT NOT NULL DEFAULT 0,
  unrecoverable   BIGINT NOT NULL DEFAULT 0
);

INSERT INTO publication_evidence_transition (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE VIEW v_listing_history_contract AS
WITH first_observation AS (
  SELECT article_id, min(effective_at) AS first_observed_at
    FROM listing_state_history
   WHERE event_type IN ('search_sighting', 'detail_update', 'reopened')
   GROUP BY article_id
), first_price AS (
  SELECT article_id, min(effective_at) AS first_supported_price_at
    FROM listing_price_events
   WHERE price_state = 'valid' AND price IS NOT NULL
   GROUP BY article_id
), publication AS (
  SELECT article_id, min(published_at) AS publication_at
    FROM listing_publication_evidence
   GROUP BY article_id
)
SELECT l.article_id,
       COALESCE(p.publication_at, l.published_at) AS publication_at,
       CASE WHEN COALESCE(p.publication_at, l.published_at) IS NULL
            THEN 'unknown' ELSE 'known' END AS publication_status,
       f.first_observed_at,
       fp.first_supported_price_at,
       CASE
         WHEN f.first_observed_at IS NULL THEN 'unknown_before_observation'
         WHEN COALESCE(p.publication_at, l.published_at) IS NULL
           THEN 'unknown_publication'
         WHEN COALESCE(p.publication_at, l.published_at) < f.first_observed_at
           THEN 'unknown_before_first_observation'
         ELSE 'observed_from_publication'
       END AS pre_observation_status,
       l.first_seen,
       l.closed_at
  FROM listings l
  LEFT JOIN publication p USING (article_id)
  LEFT JOIN first_observation f USING (article_id)
  LEFT JOIN first_price fp USING (article_id);

CREATE OR REPLACE VIEW v_listing_evidence_timeline AS
SELECT article_id, effective_at, observed_at, ingested_at,
       'price'::text AS evidence_kind, price_state AS state,
       price, source, provenance
  FROM listing_price_events
UNION ALL
SELECT article_id, effective_at, NULL::timestamptz, ingested_at,
       'state'::text, event_type,
       price, source, filter_attributes
  FROM listing_state_history
UNION ALL
SELECT article_id, published_at, observed_at, ingested_at,
       'publication'::text, evidence_kind,
       NULL::numeric, source, '{}'::jsonb
  FROM listing_publication_evidence;

COMMENT ON VIEW v_listing_history_contract IS
  'Per-article publication, first observation, supported price boundary, and explicit pre-observation gap contract.';
COMMENT ON VIEW v_listing_evidence_timeline IS
  'Normalized evidence timeline retained after raw response expiry; no synthetic prices or availability are added.';
