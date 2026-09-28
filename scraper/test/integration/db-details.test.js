"use strict";
// Integration tests for detail-page enrichment (05/06 migrations): attribute
// persistence, first-wins scalar semantics, JSONB merge, the details_fetched_at
// stamp, pending-detail queries and the analytics views.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;

test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
const cardsBySearch = new Map();
test.beforeEach(async () => {
  cardsBySearch.clear();
  await reset(db.pool);
});

const KEY_A = "/pretraga?category_id=23";
const KEY_B = "/pretraga?category_id=26";

async function register(key, category) {
  await db.registerSavedSearch({
    searchKey: key,
    name: "search " + key,
    url: "https://olx.ba" + key,
    category,
  });
}

const priceEvent = (row, observedAt) => ({
  articleId: row.articleId,
  effectiveAt: observedAt,
  ingestedAt: observedAt,
  price: row.price,
  priceState: row.priceState ?? (row.price == null ? "unpriced" : "valid"),
  dealType: row.isRent ? "rent" : "sale",
  source: "search",
  isCurrent: true,
  provenance: { observation: "search_card" },
});

async function commitSearch(
  key,
  cards,
  {
    category = key === KEY_B ? "houses" : "apartments",
    eventCards = cards,
    observedAt = new Date(),
  } = {},
) {
  cardsBySearch.set(key, new Map(cards.map((row) => [row.articleId, row])));
  await register(key, category);
  const runId = await db.startRun(key);
  return db.commitSearchIngestion({
    runId,
    search: {
      searchKey: key,
      name: "search " + key,
      url: "https://olx.ba" + key,
      category,
    },
    cards,
    priceEvents: eventCards.map((row) => priceEvent(row, observedAt)),
    membership: {
      searchKey: key,
      articleIds: cards.map((row) => row.articleId),
    },
    run: { status: "ok", isComplete: true, pages: 1, cards: cards.length },
    analytics: { invalidateFrom: observedAt },
  });
}

async function seed(
  articleId,
  over = {},
  key = KEY_A,
  observedAt = new Date(),
) {
  const card = {
    articleId,
    url: `https://olx.ba/artikal/${articleId}/x`,
    title: "ad " + articleId,
    sqm: null,
    rooms: "2",
    isRent: false,
    price: 100000,
    priceText: "",
    ppm2: null,
    ...over,
  };
  const cards = cardsBySearch.get(key) ?? new Map();
  cards.set(articleId, card);
  cardsBySearch.set(key, cards);
  await commitSearch(key, [...cards.values()], {
    eventCards: [card],
    observedAt,
  });
}

const rowOf = async (id) =>
  (await db.pool.query("SELECT * FROM listings WHERE article_id = $1", [id]))
    .rows[0];

needsDb(
  "enrichListings persists every detail fact and stamps the visit",
  async () => {
    await seed(7001);
    await db.enrichListings([
      {
        articleId: 7001,
        latitude: 44.812345,
        longitude: 17.198765,
        sqm: 40,
        publishedAt: new Date("2025-03-01T10:30:00Z"),
        renewedAt: new Date("2025-06-15T08:00:00Z"),
        sellerType: "shop",
        roomsDetail: "Dvosoban",
        bathrooms: 2,
        floorNum: -1,
        floorsTotal: 6,
        unitLevels: 2,
        heating: "Centralno (gradsko)",
        furnished: true,
        condition: "Novogradnja",
        parking: true,
        garage: false,
        elevator: true,
        yearBuilt: 2019,
        plotSqm: 500.5,
        orientation: "Jug",
        views: 1234,
        favorites: 7,
        characteristics: { kvadrata: 40, "broj-soba": 2 },
        sourcePayload: { id: 7001, source: "detail" },
      },
    ]);
    const r = await rowOf(7001);
    assert.equal(r.latitude, 44.812345);
    assert.deepEqual(r.published_at, new Date("2025-03-01T10:30:00Z"));
    assert.deepEqual(r.renewed_at, new Date("2025-06-15T08:00:00Z"));
    assert.equal(r.seller_type, "shop");
    assert.equal(r.rooms_detail, "Dvosoban");
    assert.equal(r.bathrooms, 2);
    assert.equal(r.floor_num, -1);
    assert.equal(r.floors_total, 6);
    assert.equal(r.unit_levels, 2);
    assert.equal(r.heating, "Centralno (gradsko)");
    assert.equal(r.furnished, true);
    assert.equal(r.condition, "Novogradnja");
    assert.equal(r.parking, true);
    assert.equal(r.garage, false);
    assert.equal(r.elevator, true);
    assert.equal(r.year_built, 2019);
    assert.equal(Number(r.plot_sqm), 500.5);
    assert.equal(r.orientation, "Jug");
    assert.equal(r.views, 1234);
    assert.equal(r.favorites, 7);
    assert.ok(r.details_fetched_at);
    // learned m² on a priced sale ad derives ppm² (100000 / 40):
    assert.equal(Number(r.sqm), 40);
    assert.equal(r.ppm2, 2500);
    const archived = await db.pool.query(
      `SELECT request_kind, article_id::int AS article_id, payload
         FROM raw_api_responses WHERE article_id = 7001`,
    );
    assert.deepEqual(archived.rows, [
      {
        request_kind: "detail",
        article_id: 7001,
        payload: { id: 7001, source: "detail" },
      },
    ]);
  },
);

needsDb(
  "raw response archives retain source payload and bounded diagnostics",
  async () => {
    await db.archiveSearchResponse({
      runId: null,
      requestKind: "search",
      requestUrl: "https://olx.ba/api/search?category_id=23&page=1",
      parserVersion: "search-v1",
      buildVersion: "test-build",
      payload: {
        items: [{ id: 7003 }],
        meta: { total: 1 },
      },
      sourcePayload: {
        data: [{ id: 7003, title: "source" }],
        meta: { total: 1, last_page: 1 },
      },
      requestMetadata: {
        method: "GET",
        url: "https://olx.ba/api/search?category_id=23&page=1",
      },
      responseMetadata: {
        status: 200,
        contentType: "application/json",
        bytes: 42,
        attempts: 1,
      },
    });
    await db.archiveResponseDiagnostic({
      articleId: null,
      requestKind: "search",
      requestUrl: "https://olx.ba/api/search?category_id=23&page=2",
      error: Object.assign(new Error("blocked"), {
        requestMetadata: { method: "GET" },
        responseMetadata: { status: 403 },
        diagnostic: { kind: "http", status: 403, body: "challenge" },
      }),
      buildVersion: "test-build",
    });
    const rows = await db.pool.query(
      `SELECT parser_version, build_version, payload, source_payload,
              request_metadata, response_metadata, diagnostic
         FROM raw_api_responses
        WHERE request_url LIKE '%category_id=23%'
        ORDER BY id`,
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0].build_version, "test-build");
    assert.deepEqual(rows.rows[0].source_payload.data, [
      { id: 7003, title: "source" },
    ]);
    assert.equal(rows.rows[0].response_metadata.status, 200);
    assert.equal(rows.rows[1].diagnostic.kind, "http");
    assert.equal(rows.rows[1].response_metadata.status, 403);
  },
);

needsDb(
  "listing-state characteristics are shared without changing logical JSONB or null semantics",
  async () => {
    const characteristics = {
      amenities: Array.from({ length: 32 }, (_, i) => ({
        key: `amenity-${i}`,
        value: `value-${i}`,
      })),
    };
    const attributes = [
      { characteristics, title: "first title" },
      { characteristics, title: "second title" },
      { characteristics: null, title: "explicit null" },
      { title: "missing characteristics" },
    ];
    const ids = [];
    for (const filterAttributes of attributes) {
      const result = await db.pool.query(
        `SELECT public.get_or_create_listing_state_version(
                  'apartments', ARRAY['apartments'], false, 80, '2',
                  $1::jsonb, false, false) AS state_version_id`,
        [JSON.stringify(filterAttributes)],
      );
      ids.push(result.rows[0].state_version_id);
    }

    const rows = await db.pool.query(
      `SELECT v.state_version_id, v.filter_attributes,
              r.characteristic_document_id
         FROM public.listing_state_versions v
         JOIN public.listing_state_version_records r USING (state_version_id)
        WHERE v.state_version_id = ANY($1::bigint[])
        ORDER BY array_position($1::bigint[], v.state_version_id)`,
      [ids],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.filter_attributes),
      attributes,
    );
    assert.equal(
      rows.rows[0].characteristic_document_id,
      rows.rows[1].characteristic_document_id,
    );
    assert.notEqual(
      rows.rows[2].characteristic_document_id,
      null,
      "an explicit JSON null remains present in the logical document",
    );
    assert.equal(
      rows.rows[3].characteristic_document_id,
      null,
      "a missing characteristics key remains missing",
    );
  },
);

needsDb(
  "listing-state logical compatibility view remains writable by the app role",
  async () => {
    const attributes = {
      characteristics: { features: ["balcony", "elevator"] },
      searchAttributes: { title: "compatibility test" },
    };
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE olx_app");
      const result = await client.query(
        `INSERT INTO public.listing_state_versions
           (state_hash, category, category_membership, is_rent, sqm, rooms,
            filter_attributes)
         VALUES (public.listing_state_version_hash(
                   'apartments', ARRAY['apartments'], false, 60, '2',
                   $1::jsonb, false, false),
                 'apartments', ARRAY['apartments'], false, 60, '2', $1::jsonb)
         RETURNING state_version_id, filter_attributes`,
        [JSON.stringify(attributes)],
      );
      assert.deepEqual(result.rows[0].filter_attributes, attributes);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
);

needsDb(
  "raw JSON fragments are shared losslessly and reclaimed after their final response",
  async () => {
    const shared = {
      category: { id: 23, name: "Stanovi" },
      photos: Array.from({ length: 40 }, (_, i) => ({
        url: `https://img.olx.ba/${i}/large.jpg`,
      })),
    };
    for (const page of [1, 2]) {
      await db.archiveSearchResponse({
        requestKind: "search",
        requestUrl: `https://olx.ba/api/search?category_id=23&page=${page}`,
        payload: { page, repeated: shared },
      });
    }
    await db.pool.query("SELECT public.compact_raw_api_response_batch(100)");

    const sharedId = (
      await db.pool.query(
        `SELECT document_id FROM storage_json_documents
          WHERE content_hash = encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex')`,
        [JSON.stringify(shared)],
      )
    ).rows[0]?.document_id;
    assert.ok(sharedId, "the repeated JSON object is interned");
    const refs = await db.pool.query(
      `SELECT count(*)::int AS count FROM storage_json_parts WHERE value_id = $1`,
      [sharedId],
    );
    assert.equal(refs.rows[0].count, 2);

    const reconstructed = await db.pool.query(
      `SELECT source_payload FROM raw_api_responses ORDER BY request_url`,
    );
    assert.deepEqual(
      reconstructed.rows.map((row) => row.source_payload),
      [1, 2].map((page) => ({ page, repeated: shared })),
    );

    await db.pool.query(
      `DELETE FROM raw_api_response_records WHERE request_url LIKE '%page=1'`,
    );
    await db.pool.query(
      "SELECT public.purge_unreferenced_storage_json_documents()",
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT EXISTS (SELECT 1 FROM storage_json_documents WHERE document_id = $1) AS present",
          [sharedId],
        )
      ).rows[0].present,
      true,
      "the second response still references the shared object",
    );

    await db.pool.query(
      `DELETE FROM raw_api_response_records WHERE request_url LIKE '%page=2'`,
    );
    await db.pool.query(
      "SELECT public.purge_unreferenced_storage_json_documents()",
    );
    assert.equal(
      (
        await db.pool.query(
          "SELECT EXISTS (SELECT 1 FROM storage_json_documents WHERE document_id = $1) AS present",
          [sharedId],
        )
      ).rows[0].present,
      false,
      "the fragment is reclaimed after the last response expires",
    );
  },
);

needsDb(
  "raw-response retention ranks pending rows and compacts the retained bodies",
  async () => {
    const requestUrl = "https://olx.ba/api/search?category_id=23&retention=1";
    for (let page = 1; page <= 4; page += 1) {
      await db.archiveSearchResponse({
        requestKind: "search",
        requestUrl,
        fetchedAt: new Date(Date.now() + page),
        payload: { page },
      });
    }

    assert.equal(await db.purgeRawResponses(1000), 1);
    const retained = await db.pool.query(
      `SELECT source_payload FROM raw_api_responses
        WHERE request_url = $1 ORDER BY fetched_at, id`,
      [requestUrl],
    );
    assert.deepEqual(
      retained.rows.map((row) => row.source_payload),
      [{ page: 2 }, { page: 3 }, { page: 4 }],
    );
    const physical = await db.pool.query(
      `SELECT (SELECT count(*)::int FROM raw_api_response_pending
                WHERE request_url = $1) AS pending,
              (SELECT count(*)::int FROM raw_api_response_records
                WHERE request_url = $1) AS compacted`,
      [requestUrl],
    );
    assert.deepEqual(physical.rows[0], { pending: 0, compacted: 3 });
  },
);

needsDb(
  "the logical raw-response view remains writable by the app role",
  async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE olx_app");
      await client.query(
        `INSERT INTO public.raw_api_responses
           (request_kind, request_url, parser_version, payload)
         VALUES ('search', 'https://olx.ba/api/search?legacy=1', 'compat-test',
                 $1::jsonb)`,
        [JSON.stringify({ rows: [{ id: 7004 }] })],
      );
      const selected = await client.query(
        `SELECT payload FROM public.raw_api_responses
          WHERE request_url = 'https://olx.ba/api/search?legacy=1'`,
      );
      assert.deepEqual(selected.rows, [{ payload: { rows: [{ id: 7004 }] } }]);
      await client.query(
        `DELETE FROM public.raw_api_responses
          WHERE request_url = 'https://olx.ba/api/search?legacy=1'`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
);

needsDb(
  "scalars are first-wins; renewed_at moves forward; characteristics merge",
  async () => {
    await seed(7002);
    await db.enrichListings([
      {
        articleId: 7002,
        heating: "Struja",
        publishedAt: new Date("2024-01-01T00:00:00Z"),
        renewedAt: new Date("2025-01-01T00:00:00Z"),
        views: 100,
        characteristics: { kvadrata: 55 },
      },
    ]);
    const stampedOnce = (await rowOf(7002)).details_fetched_at;
    await db.enrichListings([
      {
        articleId: 7002,
        heating: "Plin",
        publishedAt: new Date("2026-08-21T15:09:00Z"),
        renewedAt: new Date("2025-06-01T00:00:00Z"),
        views: 9999,
        characteristics: { lift: "Da" },
      },
    ]);
    const r = await rowOf(7002);
    assert.equal(r.heating, "Struja"); // never overwritten
    assert.deepEqual(r.published_at, new Date("2024-01-01T00:00:00Z"));
    assert.deepEqual(r.renewed_at, new Date("2025-06-01T00:00:00Z")); // moved FORWARD
    assert.equal(r.views, 100);
    assert.deepEqual(r.characteristics, { kvadrata: 55, lift: "Da" }); // merged
    assert.ok(r.details_fetched_at.getTime() >= stampedOnce.getTime());
  },
);

needsDb(
  "enrichListings stamps the neighborhood from map pins; first-wins",
  async () => {
    await seed(7010);
    // Trg Krajine area -> inside the Centar 2 MZ polygon (09-neighborhood-data.sql):
    await db.enrichListings([
      {
        articleId: 7010,
        latitude: 44.7725,
        longitude: 17.1905,
        characteristics: {},
      },
    ]);
    assert.equal((await rowOf(7010)).location, "Centar 2");
    // A pin outside every district leaves location empty:
    await seed(7011);
    await db.enrichListings([
      { articleId: 7011, latitude: 44.9, longitude: 17.5, characteristics: {} },
    ]);
    assert.equal((await rowOf(7011)).location, null);
    // First-wins: a later pass with a different pin never re-labels (the second
    // pin at 44.7940/17.2000 would map to Petricevac, but 7010 keeps its value).
    await db.enrichListings([
      {
        articleId: 7010,
        latitude: 44.794,
        longitude: 17.2,
        characteristics: {},
      },
    ]);
    assert.equal((await rowOf(7010)).location, "Centar 2");
  },
);

needsDb(
  "enrichmentQueue: never-attempted first, then oldest attempt, capped",
  async () => {
    await seed(7101);
    await seed(7102);
    await seed(7103); // all three lack pin + m² + a detail visit

    const firstPass = await db.enrichmentQueue([7101, 7102, 7103], 2);
    assert.deepEqual(
      firstPass.pending.map((p) => p.id),
      [7101, 7102],
    ); // NULLS FIRST → id order
    assert.equal(firstPass.total, 3); // backlog size reported beyond the cap
    assert.equal(firstPass.pending[0].unpinned, true);
    assert.equal(firstPass.pending[0].missingSqm, true);
    assert.equal(firstPass.pending[0].neverDetailed, true);

    // Attempting 7101 rotates it behind the untouched rows…
    await db.enrichListings([{ articleId: 7101, characteristics: {} }]);
    const secondPass = await db.enrichmentQueue([7101, 7102, 7103], 5);
    assert.deepEqual(
      secondPass.pending.map((p) => p.id),
      [7102, 7103, 7101],
    );
  },
);

needsDb(
  "enrichmentQueue: skips closed rows; empty when nothing is pending",
  async () => {
    await seed(7104, {}, KEY_A, new Date("2025-01-01T00:00:00Z"));
    await db.enrichListings([
      {
        articleId: 7104,
        latitude: 44.9,
        longitude: 17.3,
        sqm: 50,
        characteristics: {},
      },
    ]); // fully enriched
    const q = await db.enrichmentQueue([7104], 25);
    assert.deepEqual(q.pending, []);
    assert.equal(q.total, 0);
  },
);

needsDb(
  "getListingsNeedingDetails includes rows never detail-fetched",
  async () => {
    await seed(7005, { sqm: 50, price: 100000, priceText: "", ppm2: 2000 }); // sqm complete
    assert.equal(
      (await db.getListingsNeedingDetails(true)).filter(
        (t) => Number(t.articleId) === 7005,
      ).length,
      1,
    );
    // Pin + stamp together — with both present the row leaves the queue:
    await db.enrichListings([
      { articleId: 7005, latitude: 44.9, longitude: 17.3, characteristics: {} },
    ]);
    assert.equal(
      (await db.getListingsNeedingDetails(true)).filter(
        (t) => Number(t.articleId) === 7005,
      ).length,
      0,
    );
  },
);

needsDb("v_listing_lifecycle exposes opening/closing economics", async () => {
  await seed(
    7006,
    { sqm: 50, price: 100000, priceText: "", ppm2: 2000 },
    KEY_A,
    new Date("2026-09-05T08:00:00Z"),
  );
  await seed(
    7006,
    {
      title: "ad 7006 cut",
      sqm: 50,
      price: 90000,
      priceText: "",
      ppm2: 1800,
    },
    KEY_A,
    new Date("2026-09-05T09:00:00Z"),
  );
  await commitSearch(KEY_A, [], {
    observedAt: new Date("2026-09-05T10:00:00Z"),
  });

  const lc = (
    await db.pool.query(
      "SELECT * FROM v_listing_lifecycle WHERE article_id = 7006",
    )
  ).rows[0];
  assert.equal(Number(lc.opening_price), 100000);
  assert.equal(Number(lc.last_history_price), 90000);
  assert.equal(lc.n_changes, 2);
  assert.equal(Number(lc.closing_price), 90000);
  assert.equal(lc.is_closed, true);
  assert.equal(lc.category, "apartments");
  assert.equal(typeof lc.days_listed, "number");
  assert.ok(lc.days_listed >= 0);

  // Active listings still appear through the view, flagged open:
  await seed(7007);
  const lc7 = (
    await db.pool.query(
      "SELECT is_closed FROM v_listing_lifecycle WHERE article_id = 7007",
    )
  ).rows[0];
  assert.equal(lc7.is_closed, false);
});

needsDb(
  "v_market_daily sums births/deaths and tracks live inventory",
  async () => {
    await seed(7008); // will be closed below
    await seed(7009, {}, KEY_B); // stays open
    await commitSearch(KEY_A, []);

    const daily = (
      await db.pool.query("SELECT * FROM v_market_daily ORDER BY day")
    ).rows;
    assert.ok(daily.length >= 1);
    assert.equal(
      daily.reduce((s, r) => s + r.new_n, 0),
      2,
    );
    assert.equal(
      daily.reduce((s, r) => s + r.closed_n, 0),
      1,
    );
    assert.equal(daily[daily.length - 1].active_est, 1);
  },
);

needsDb("daily rebuild normalizes nullable inferred flags", async () => {
  await seed(7010);
  await db.pool.query(
    `INSERT INTO listing_state_history
         (article_id, effective_at, source, event_type, state_version_id,
          last_seen_at)
       VALUES ($1, now(), 'search', 'search_sighting',
               get_or_create_listing_state_version(
                 NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false),
               now())`,
    [7010],
  );

  await db.rebuildDailyInventory();
  const daily = (
    await db.pool.query(
      `SELECT membership_inferred, attributes_inferred
           FROM listing_daily_state WHERE article_id = 7010`,
    )
  ).rows[0];

  assert.ok(daily);
  assert.equal(daily.membership_inferred, false);
  assert.equal(daily.attributes_inferred, false);
});

needsDb(
  "daily rebuild preserves conflicting price quality without counting it as priced",
  async () => {
    const observedAt = new Date("2026-02-10T10:00:00Z");
    await seed(7011, { price: 100000, sqm: 50, ppm2: 2000 }, KEY_A, observedAt);

    await db.recordPriceEvents([
      {
        articleId: 7011,
        effectiveAt: observedAt,
        ingestedAt: new Date("2026-02-10T10:01:00Z"),
        price: 90000,
        dealType: "sale",
        source: "detail",
        isCurrent: true,
        provenance: { observation: "conflicting_test_assertion" },
      },
    ]);

    await db.pool.query(
      "SELECT * FROM rebuild_listing_daily($1::date, $1::date)",
      ["2026-02-10"],
    );
    const daily = await db.pool.query(
      `SELECT price_state, price, ppm2
         FROM listing_daily_state WHERE article_id = 7011 AND day = '2026-02-10'`,
    );
    assert.equal(daily.rows[0].price_state, "conflict");
    assert.equal(daily.rows[0].price, null);
    assert.equal(daily.rows[0].ppm2, null);
  },
);

needsDb(
  "detail enrichment records a historical detail_update observation",
  async () => {
    await seed(7012, { sqm: null, ppm2: null });
    await db.enrichListings([
      {
        articleId: 7012,
        latitude: 44.78,
        longitude: 17.19,
        sqm: 62,
        price: 124000,
        ppm2: 2000,
        isRent: false,
        sellerType: "private",
        characteristics: { heating: "gas" },
      },
    ]);

    const history = await db.pool.query(
      `SELECT source, event_type, sqm, price, ppm2,
            filter_attributes->>'sellerType' AS seller_type,
            filter_attributes->>'latitude' AS latitude
       FROM listing_state_history_state
      WHERE article_id = 7012 AND event_type = 'detail_update'`,
    );
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].source, "detail");
    assert.equal(history.rows[0].sqm, "62.00");
    assert.equal(history.rows[0].price, "124000.00");
    assert.equal(history.rows[0].ppm2, 2000);
    assert.equal(history.rows[0].seller_type, "private");
    assert.equal(history.rows[0].latitude, "44.78");
  },
);
