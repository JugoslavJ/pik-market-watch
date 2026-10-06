"use strict";

const { computeMedian } = require("./statistics");

const LIFECYCLE_LOCK = "pik-market-watch lean listing lifecycle";

function uniqueCards(cards) {
  const byId = new Map();
  (cards || []).forEach((card) => {
    const id = Number(card.articleId);
    if (Number.isSafeInteger(id) && id > 0) byId.set(id, card);
  });
  return [...byId.values()];
}

function rate(price, sqm, deal) {
  if (
    deal !== "sale" ||
    price == null ||
    sqm == null ||
    Number(price) < 3000 ||
    Number(sqm) < 5 ||
    Number(sqm) > 500
  )
    return null;
  const result = Math.round(Number(price) / Number(sqm));
  return result >= 1 && result <= 15000 ? result : null;
}

function hasValidPrice(item) {
  return (
    item.pricePresent !== false &&
    item.priceState !== "invalid" &&
    item.priceState !== "unpriced" &&
    item.price != null
  );
}

// Containing boundaries are an indexed lookup; only points outside every
// neighborhood pay for geodesic distances, prefiltered to at least 5 km.
async function classify(client, ids) {
  if (!ids.length) return;
  await client.query(
    `UPDATE lean.listings l SET
       property_type=c.property_type,neighborhood=c.neighborhood
     FROM (
       SELECT s.article_id,
         CASE WHEN cardinality(s.search_keys)=0 THEN s.property_type ELSE (
           SELECT CASE WHEN count(DISTINCT ss.category) = 1
                         AND bool_and(ss.category IN ('apartments','houses','vacation_homes'))
                       THEN min(ss.category) ELSE NULL END
             FROM unnest(s.search_keys) k
             JOIN lean.saved_searches ss ON ss.search_key = k
         ) END AS property_type,
         COALESCE(
           (SELECT n.name FROM lean.neighborhoods n
             WHERE n.name = NULLIF(BTRIM(s.extra->>'location'), '')
             LIMIT 1),
           (SELECT n.name FROM lean.neighborhoods n
             WHERE ST_Covers(n.boundary, pt.p) ORDER BY n.name LIMIT 1),
           (SELECT n.name FROM lean.neighborhoods n
             WHERE ST_DWithin(n.boundary, pt.p, 5500 / (111320 * cos(radians(s.latitude))))
               AND ST_DWithin(n.boundary::geography, pt.p::geography, 5000)
             ORDER BY ST_Distance(n.boundary::geography, pt.p::geography), n.name
             LIMIT 1),
           s.neighborhood) AS neighborhood
       FROM lean.listings s
       CROSS JOIN LATERAL (
         SELECT ST_SetSRID(ST_MakePoint(s.longitude, s.latitude), 4326) AS p
       ) pt
       WHERE s.article_id = ANY($1::bigint[])
     ) c
     WHERE l.article_id = c.article_id
       AND (l.property_type,l.neighborhood)
           IS DISTINCT FROM (c.property_type,c.neighborhood)`,
    [ids],
  );
}

async function recordLifecycleEvents(client, ids, eventType) {
  if (!ids.length) return;
  await client.query(
    `INSERT INTO lean.listing_lifecycle_events
       (article_id,event_type,occurred_at,opened_at,price,deal,property_type,
        neighborhood,sqm,rooms,latitude,longitude,title,url)
     SELECT l.article_id,$2::text,
            CASE WHEN $2='closed' THEN l.closed_at
                 ELSE (l.last_seen AT TIME ZONE 'Europe/Sarajevo')::date END,
            CASE WHEN $2='closed' THEN COALESCE((
              SELECT max(e.occurred_at) FROM lean.listing_lifecycle_events e
               WHERE e.article_id=l.article_id AND e.event_type='reopened'
                 AND e.occurred_at<=l.closed_at
            ),l.first_seen) ELSE NULL END,
            CASE WHEN $2='closed' THEN l.closing_price ELSE l.price END,
            l.deal,l.property_type,l.neighborhood,l.sqm,l.rooms,
            l.latitude,l.longitude,l.title,l.url
       FROM lean.listings l WHERE l.article_id=ANY($1::bigint[])
`,
    [ids, eventType],
  );
}

async function registerSavedSearch({ searchKey, name, url, category }) {
  await this.pool.query(
    `INSERT INTO lean.saved_searches (search_key,name,url,category)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (search_key) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,category=EXCLUDED.category`,
    [searchKey, name, url, category ?? null],
  );
}

async function startRun(searchKey) {
  const result = await this.pool.query(
    "INSERT INTO lean.scrape_runs (search_key) VALUES ($1) RETURNING id",
    [searchKey],
  );
  return Number(result.rows[0].id);
}

async function recoverAbandonedRuns(minutes) {
  const result = await this.pool.query(
    `UPDATE lean.scrape_runs SET finished_at=now(),status='error',is_complete=false,
       error='scraper process stopped before run completion',
       failure_reason='abandoned run recovered at startup'
     WHERE status='running' AND finished_at IS NULL
       AND started_at < now()-make_interval(mins => $1::int)`,
    [minutes],
  );
  return result.rowCount;
}

async function finishRun(runId, outcome) {
  await this.pool.query(
    `UPDATE lean.scrape_runs SET finished_at=now(),status=$2,pages=$3,cards=$4,error=$5,
       is_complete=$6,failure_reason=$7,truncation_reason=$8 WHERE id=$1`,
    [
      runId,
      outcome.status,
      outcome.pages ?? null,
      outcome.cards ?? null,
      outcome.error ?? null,
      outcome.isComplete === true,
      outcome.failureReason ?? null,
      outcome.truncationReason ?? null,
    ],
  );
}

async function hasRecentFinishedRun(minutes, searchKey) {
  const result = await this.pool.query(
    `SELECT 1 FROM lean.scrape_runs WHERE status='ok' AND is_complete
       AND finished_at > now()-make_interval(mins => $1::int)
       AND search_key=$2 LIMIT 1`,
    [minutes, searchKey],
  );
  return result.rowCount > 0;
}

async function commitSearchIngestion(payload) {
  const cards = uniqueCards(payload.cards);
  const ids = cards.map((card) => Number(card.articleId));
  const searchKey = payload.search.searchKey;
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      LIFECYCLE_LOCK,
    ]);
    await client.query(
      `INSERT INTO lean.saved_searches (search_key,name,url,category)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (search_key) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,category=EXCLUDED.category`,
      [
        searchKey,
        payload.search.name,
        payload.search.url,
        payload.search.category ?? null,
      ],
    );
    const previous = await client.query(
      "SELECT article_id,price,ppm2,deal,closed_at FROM lean.listings WHERE article_id=ANY($1::bigint[]) FOR UPDATE",
      [ids],
    );
    const byId = new Map(
      previous.rows.map((row) => [Number(row.article_id), row]),
    );
    const newIds = ids.filter((id) => !byId.has(id));
    const observations = cards.map((card) => {
      const deal =
        card.dealType === "rent" || card.isRent === true
          ? "rent"
          : card.dealType === "sale" ||
              (!Object.hasOwn(card, "dealType") && card.isRent === false)
            ? "sale"
            : "unknown";
      const validPrice = hasValidPrice(card);
      const prior = byId.get(Number(card.articleId));
      const price = validPrice
        ? card.price
        : prior?.deal !== deal
          ? null
          : (prior?.price ?? null);
      const sqm = card.sqm ?? null;
      return {
        article_id: Number(card.articleId),
        url: card.url,
        title: card.title,
        deal,
        sqm,
        rooms: card.rooms ?? null,
        price,
        price_text: card.priceText ?? null,
        currency: card.priceCurrency || "unknown",
        ppm2: rate(price, sqm, deal),
        latitude: card.latitude ?? null,
        longitude: card.longitude ?? null,
        seller_type: card.sellerType ?? null,
        renewed_at: card.renewedAt ?? null,
        api_status: card.apiStatus ?? null,
        extra: {
          latest_price_state:
            card.priceState ?? (validPrice ? "valid" : "unpriced"),
        },
        valid_price: validPrice,
      };
    });
    if (observations.length) {
      await client.query(
        `INSERT INTO lean.listings
           (article_id,url,title,deal,sqm,rooms,price,price_text,currency,ppm2,
            latitude,longitude,seller_type,renewed_at,api_status,extra,search_keys)
         SELECT article_id,url,title,deal,sqm,rooms,price,price_text,currency,ppm2,
                latitude,longitude,seller_type,
                (renewed_at AT TIME ZONE 'Europe/Sarajevo')::date,
                api_status,extra,ARRAY[$2::text]
           FROM jsonb_to_recordset($1::jsonb) AS i(
             article_id bigint,url text,title text,deal text,sqm numeric,rooms text,
             price numeric,price_text text,currency text,ppm2 integer,
             latitude float8,longitude float8,seller_type text,
             renewed_at timestamptz,api_status text,extra jsonb,valid_price boolean)
         ON CONFLICT (article_id) DO UPDATE SET
           url=EXCLUDED.url,title=EXCLUDED.title,deal=EXCLUDED.deal,
           sqm=COALESCE(EXCLUDED.sqm,lean.listings.sqm),
           rooms=COALESCE(EXCLUDED.rooms,lean.listings.rooms),
           price=EXCLUDED.price,
           price_text=COALESCE(EXCLUDED.price_text,lean.listings.price_text),
           currency=EXCLUDED.currency,
           ppm2=CASE WHEN EXCLUDED.deal='sale' AND EXCLUDED.price>=3000
                       AND COALESCE(EXCLUDED.sqm,lean.listings.sqm) BETWEEN 5 AND 500
                       AND round(EXCLUDED.price/NULLIF(COALESCE(EXCLUDED.sqm,lean.listings.sqm),0)) BETWEEN 1 AND 15000
                     THEN round(EXCLUDED.price/NULLIF(COALESCE(EXCLUDED.sqm,lean.listings.sqm),0))::int
                     ELSE NULL END,
           latitude=COALESCE(EXCLUDED.latitude,lean.listings.latitude),
           longitude=COALESCE(EXCLUDED.longitude,lean.listings.longitude),
           seller_type=COALESCE(EXCLUDED.seller_type,lean.listings.seller_type),
           renewed_at=GREATEST(EXCLUDED.renewed_at,lean.listings.renewed_at),
           api_status=COALESCE(EXCLUDED.api_status,lean.listings.api_status),
           extra=lean.listings.extra || EXCLUDED.extra,
           search_keys=CASE WHEN $2::text=ANY(lean.listings.search_keys)
                            THEN lean.listings.search_keys
                            ELSE array_append(lean.listings.search_keys,$2::text) END,
           last_seen=now(),closed_at=NULL,closing_price=NULL`,
        [JSON.stringify(observations), searchKey],
      );
      await classify(client, ids);
      await recordLifecycleEvents(
        client,
        previous.rows
          .filter((row) => row.closed_at != null)
          .map((row) => Number(row.article_id)),
        "reopened",
      );
    }
    const changed = observations.filter((item) => {
      if (!item.valid_price) return false;
      const prior = byId.get(item.article_id);
      return (
        !prior ||
        prior.deal !== item.deal ||
        Number(prior.price) !== Number(item.price)
      );
    });
    if (changed.length) {
      await client.query(
        `INSERT INTO lean.price_history (article_id,price_date,price,currency,source)
         SELECT article_id,(now() AT TIME ZONE 'Europe/Sarajevo')::date,price,currency,'search'
           FROM jsonb_to_recordset($1::jsonb) AS i(
             article_id bigint,price numeric,currency text)
           ON CONFLICT (article_id,price_date,source) DO UPDATE
             SET price=EXCLUDED.price,currency=EXCLUDED.currency`,
        [JSON.stringify(changed)],
      );
    }
    const removed = await client.query(
      `UPDATE lean.listings SET search_keys=array_remove(search_keys,$1::text)
        WHERE $1::text=ANY(search_keys) AND NOT (article_id=ANY($2::bigint[]))
        RETURNING article_id`,
      [searchKey, ids],
    );
    const removedIds = removed.rows.map((row) => Number(row.article_id));
    let closedCount = 0;
    if (removedIds.length) {
      await classify(client, removedIds);
      const closed = await client.query(
        `UPDATE lean.listings
            SET closed_at=(now() AT TIME ZONE 'Europe/Sarajevo')::date,
                closing_price=price
          WHERE article_id=ANY($1::bigint[]) AND cardinality(search_keys)=0 AND closed_at IS NULL
          RETURNING article_id`,
        [removedIds],
      );
      closedCount = closed.rowCount;
      await recordLifecycleEvents(
        client,
        closed.rows.map((row) => Number(row.article_id)),
        "closed",
      );
    }
    const currentRates = new Map(
      (
        await client.query(
          "SELECT article_id,ppm2 FROM lean.listings WHERE article_id=ANY($1::bigint[])",
          [ids],
        )
      ).rows.map((row) => [Number(row.article_id), row.ppm2]),
    );
    const dropCount = observations.filter((item) => {
      const prior = byId.get(item.article_id);
      const current = currentRates.get(item.article_id);
      return (
        item.valid_price &&
        prior?.ppm2 != null &&
        current != null &&
        Number(current) < Number(prior.ppm2)
      );
    }).length;
    const median = computeMedian(
      observations
        .filter(
          (item) =>
            item.valid_price && Number(currentRates.get(item.article_id)) > 0,
        )
        .map((item) => Number(currentRates.get(item.article_id))),
    );
    const run = payload.run || {};
    await client.query(
      `UPDATE lean.saved_searches SET last_scraped_at=now(),listing_count=$2,
         median_ppm2=$3,new_count=$4,drop_count=$5 WHERE search_key=$1`,
      [
        searchKey,
        run.listingCount ?? cards.length,
        median,
        newIds.length,
        dropCount,
      ],
    );
    await client.query(
      `UPDATE lean.scrape_runs SET finished_at=now(),status=$2,pages=$3,cards=$4,
         error=NULL,is_complete=$5,failure_reason=NULL,truncation_reason=NULL WHERE id=$1`,
      [
        payload.runId,
        run.status || "ok",
        run.pages ?? null,
        run.cards ?? cards.length,
        run.isComplete !== false,
      ],
    );
    await client.query("COMMIT");
    return { newCount: newIds.length, dropCount, closedCount, newIds, median };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function closeUnseenListings(activeKeys) {
  if (!activeKeys.length) return 0;
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      LIFECYCLE_LOCK,
    ]);
    const removed = await client.query(
      `UPDATE lean.listings l SET search_keys=(
         SELECT COALESCE(array_agg(k ORDER BY k),'{}'::text[])
           FROM unnest(l.search_keys) k WHERE k=ANY($1::text[]))
       WHERE EXISTS (SELECT 1 FROM unnest(l.search_keys) k WHERE NOT k=ANY($1::text[]))
       RETURNING article_id`,
      [activeKeys],
    );
    if (removed.rowCount)
      await classify(
        client,
        removed.rows.map((row) => Number(row.article_id)),
      );
    const closed = await client.query(
      `UPDATE lean.listings
          SET closed_at=(now() AT TIME ZONE 'Europe/Sarajevo')::date,
              closing_price=price
        WHERE closed_at IS NULL AND cardinality(search_keys)=0 RETURNING article_id`,
    );
    await recordLifecycleEvents(
      client,
      closed.rows.map((row) => Number(row.article_id)),
      "closed",
    );
    await client.query("COMMIT");
    return closed.rowCount;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function enrichListings(rows) {
  if (!rows?.length) return;
  const archived = rows.filter((row) => row.sourcePayload);
  if (archived.length)
    await this.archiveDetailResponses(
      archived.map((row) => ({
        articleId: row.articleId,
        sourcePayload: row.sourcePayload,
        requestMetadata: row.sourceRequestMetadata,
        responseMetadata: row.sourceResponseMetadata,
        buildVersion: row.sourceBuildVersion,
      })),
    );
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const old = await client.query(
        "SELECT price,deal FROM lean.listings WHERE article_id=$1 FOR UPDATE",
        [row.articleId],
      );
      if (!old.rowCount) continue;
      const prior = old.rows[0];
      const deal =
        row.dealType === "rent" || row.isRent === true
          ? "rent"
          : row.dealType === "sale" || row.isRent === false
            ? "sale"
            : Object.hasOwn(row, "dealType")
              ? "unknown"
              : prior.deal;
      const validPrice = hasValidPrice(row);
      const price = validPrice
        ? row.price
        : deal !== prior.deal
          ? null
          : prior.price;
      const extra = {};
      for (const key of [
        "roomsDetail",
        "bathrooms",
        "floorsTotal",
        "unitLevels",
        "heating",
        "furnished",
        "garage",
        "plotSqm",
        "orientation",
        "views",
        "favorites",
        "characteristics",
        "apiPriceHistory",
      ]) {
        if (row[key] != null)
          extra[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] =
            row[key];
      }
      extra.latest_price_state =
        row.priceState ?? (validPrice ? "valid" : "unpriced");
      await client.query(
        `UPDATE lean.listings SET deal=$2,price=$3,
           currency=COALESCE($4,currency),
           price_text=COALESCE($5,price_text),
           sqm=COALESCE(sqm,$6),
           ppm2=CASE WHEN $2='sale' AND $3::numeric>=3000
                      AND COALESCE(sqm,$6) BETWEEN 5 AND 500
                      AND round($3::numeric/NULLIF(COALESCE(sqm,$6),0)) BETWEEN 1 AND 15000
                     THEN round($3::numeric/NULLIF(COALESCE(sqm,$6),0))::int
                     ELSE NULL END,
           latitude=COALESCE(latitude,$7),longitude=COALESCE(longitude,$8),
           seller_type=COALESCE($9,seller_type),condition=COALESCE($10,condition),
           parking=COALESCE($11,parking),elevator=COALESCE($12,elevator),
           floor_num=COALESCE($13,floor_num),year_built=COALESCE($14,year_built),
           published_at=COALESCE(published_at,($15::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date),
           first_seen=COALESCE(published_at,($15::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date,first_seen),
           renewed_at=GREATEST(renewed_at,
             ($16::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date),
           api_status=COALESCE($17,api_status),
           extra=extra || $18::jsonb,
           details_fetched_at=now(),last_enrichment_attempted_at=now()
         WHERE article_id=$1`,
        [
          row.articleId,
          deal,
          price,
          Object.hasOwn(row, "priceCurrency")
            ? row.priceCurrency || "unknown"
            : null,
          row.priceText ?? null,
          row.sqm ?? null,
          row.latitude ?? null,
          row.longitude ?? null,
          row.sellerType ?? null,
          row.condition ?? null,
          row.parking ?? null,
          row.elevator ?? null,
          row.floorNum ?? null,
          row.yearBuilt ?? null,
          row.publishedAt ?? null,
          row.renewedAt ?? null,
          row.apiStatus ?? null,
          JSON.stringify(extra),
        ],
      );
      const apiHistory = (row.apiPriceHistory || []).map((event, ordinal) => ({
        article_id: Number(row.articleId),
        reported_at: event.date,
        price: event.price,
        currency: event.currency || "unknown",
        ordinal: ordinal + 1,
      }));
      if (apiHistory.length) {
        await client.query(
          `WITH events AS (
             SELECT article_id,reported_at,price,currency,
                    (to_timestamp(reported_at) AT TIME ZONE 'Europe/Sarajevo')::date AS price_date,
                    ordinal
               FROM jsonb_to_recordset($1::jsonb) AS e(
                    article_id bigint,reported_at bigint,price numeric,
                    currency text,ordinal bigint)
              WHERE reported_at IS NOT NULL AND price>0
           ), daily AS (
             SELECT DISTINCT ON (article_id,price_date)
                    article_id,price_date,price,currency
               FROM events
              ORDER BY article_id,price_date,reported_at DESC,ordinal DESC
           )
           INSERT INTO lean.price_history (article_id,price_date,price,currency,source)
           SELECT article_id,price_date,price,COALESCE(NULLIF(BTRIM(currency),''),'unknown'),
                  'api_price_history'
             FROM daily
           ON CONFLICT (article_id,price_date,source) DO UPDATE
             SET price=EXCLUDED.price,currency=EXCLUDED.currency,source=EXCLUDED.source`,
          [JSON.stringify(apiHistory)],
        );
      }
    }
    const ids = rows.map((row) => Number(row.articleId));
    await classify(client, ids);
    await client.query(
      "DELETE FROM lean.price_history WHERE article_id=ANY($1::bigint[]) AND source='search'",
      [ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function enrichmentQueue(
  ids,
  limit,
  { refreshDays = 7, retryAfterMinutes = 720 } = {},
) {
  if (!ids?.length || !(limit > 0)) return { pending: [], total: 0 };
  const result = await this.pool.query(
    `SELECT l.article_id::bigint AS id,
       (l.latitude IS NULL OR l.longitude IS NULL) AS unpinned,
       (l.sqm IS NULL AND l.price IS NOT NULL AND l.deal='sale') AS missing_sqm,
       (l.details_fetched_at IS NULL) AS never_detailed,
       (l.details_fetched_at <= now()-make_interval(days => $3::int)) AS stale,
       EXISTS (SELECT 1 FROM lean.price_history p WHERE p.article_id=l.article_id
           AND p.source='search' AND p.price_date >= COALESCE((l.details_fetched_at AT TIME ZONE 'Europe/Sarajevo')::date,'-infinity'::date)) AS price_changed,
       count(*) OVER () AS pool_total
     FROM lean.listings l
     WHERE l.closed_at IS NULL AND l.article_id=ANY($1::bigint[])
       AND (l.last_enrichment_attempted_at IS NULL OR
            l.last_enrichment_attempted_at <= now()-make_interval(mins => $4::int))
       AND (l.latitude IS NULL OR l.longitude IS NULL OR
            (l.sqm IS NULL AND l.price IS NOT NULL AND l.deal='sale')
            OR l.details_fetched_at IS NULL
            OR l.details_fetched_at <= now()-make_interval(days => $3::int)
            OR EXISTS (SELECT 1 FROM lean.price_history p WHERE p.article_id=l.article_id
              AND p.source='search' AND p.price_date >= (l.details_fetched_at AT TIME ZONE 'Europe/Sarajevo')::date))
     ORDER BY (l.details_fetched_at IS NULL) DESC,
       l.last_enrichment_attempted_at ASC NULLS FIRST,l.article_id
     LIMIT $2`,
    [ids, limit, refreshDays, retryAfterMinutes],
  );
  return {
    pending: result.rows.map((item) => ({
      id: Number(item.id),
      unpinned: item.unpinned,
      missingSqm: item.missing_sqm,
      neverDetailed: item.never_detailed,
      stale: item.stale,
      priceChanged: item.price_changed,
    })),
    total: result.rows.length ? Number(result.rows[0].pool_total) : 0,
  };
}

async function markDetailAttempts(ids) {
  if (!ids?.length) return;
  await this.pool.query(
    "UPDATE lean.listings SET last_enrichment_attempted_at=now() WHERE article_id=ANY($1::bigint[])",
    [ids],
  );
}

async function getListingsNeedingDetails(onlyActive = true, options = {}) {
  const result = await this.pool.query(
    `SELECT article_id AS "articleId",url FROM lean.listings
      WHERE ($1::boolean=false OR closed_at IS NULL)
        AND (latitude IS NULL OR longitude IS NULL OR
             (sqm IS NULL AND price IS NOT NULL AND deal='sale')
             OR details_fetched_at IS NULL OR
             details_fetched_at <= now()-make_interval(days => $2::int))
      ORDER BY details_fetched_at ASC NULLS FIRST,article_id`,
    [onlyActive, options.refreshDays ?? 7],
  );
  return result.rows;
}

module.exports = {
  registerSavedSearch,
  startRun,
  recoverAbandonedRuns,
  finishRun,
  hasRecentFinishedRun,
  commitSearchIngestion,
  closeUnseenListings,
  enrichListings,
  enrichmentQueue,
  markDetailAttempts,
  getListingsNeedingDetails,
};
