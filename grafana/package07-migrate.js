const fs = require("fs");
const path = require("path");

const dashboardDir = path.join(__dirname, "dashboards");
const token = {
  category: "${category:sqlstring}",
  min: "${min_sqm}",
  max: "${max_sqm}",
  rooms: "${rooms:sqlstring}",
  deal: "${deal:sqlstring}",
  neighborhood: "${neighborhood:sqlstring}",
};

function grafana(sql) {
  return sql
    .replaceAll("__CATEGORY__", token.category)
    .replaceAll("__MIN__", token.min)
    .replaceAll("__MAX__", token.max)
    .replaceAll("__ROOMS__", token.rooms)
    .replaceAll("__DEAL__", token.deal)
    .replaceAll("__NEIGHBORHOOD__", token.neighborhood);
}

const dealArray =
  "ARRAY(SELECT CASE WHEN selected = 'sell' THEN 'sale' ELSE selected END FROM unnest(ARRAY[__DEAL__]) AS t(selected))";
const currentFilters = (alias = "l", includeDeal = true) => `
  AND room_bucket(${alias}.rooms) = ANY (ARRAY[__ROOMS__])
  ${includeDeal ? `AND CASE WHEN ${alias}.is_rent THEN 'rent' ELSE 'sell' END = ANY (ARRAY[__DEAL__])` : ""}`;
const dailyFilters = (
  alias = "d",
  includeDeal = true,
  includeNeighborhood = true,
) => `
  AND (COALESCE(cardinality(ARRAY[__CATEGORY__]), 0) = 0
    OR ${alias}.category_memberships && ARRAY[__CATEGORY__]
    OR ${alias}.category = ANY (ARRAY[__CATEGORY__]))
  AND ('__MIN__' = '' OR ${alias}.sqm IS NULL OR ${alias}.sqm >= NULLIF('__MIN__', '')::numeric)
  AND ('__MAX__' = '' OR ${alias}.sqm IS NULL OR ${alias}.sqm <= NULLIF('__MAX__', '')::numeric)
  AND (COALESCE(cardinality(ARRAY[__ROOMS__]), 0) = 0
    OR ${alias}.rooms = ANY (ARRAY[__ROOMS__])
    OR room_bucket(${alias}.rooms) = ANY (ARRAY[__ROOMS__]))
  ${includeDeal ? `AND ${alias}.deal = ANY (${dealArray})` : ""}
  ${
    includeNeighborhood
      ? `AND (COALESCE(cardinality(ARRAY[__NEIGHBORHOOD__]), 0) = 0
    OR ${alias}.neighborhood = ANY (ARRAY[__NEIGHBORHOOD__])
    OR ${alias}.location = ANY (ARRAY[__NEIGHBORHOOD__]))`
      : ""
  }`;

const dailyArgs = `
  date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo'),
  date($__timeTo() AT TIME ZONE 'Europe/Sarajevo'),
  ARRAY[__CATEGORY__],
  NULLIF('__MIN__', '')::numeric,
  NULLIF('__MAX__', '')::numeric,
  ARRAY[__ROOMS__],
  ${dealArray},
  ARRAY[__NEIGHBORHOOD__]`;

const overviewDaily =
  grafana(`SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,
       p25 AS "p25 KM/m2",
       median AS "median KM/m2",
       p75 AS "p75 KM/m2",
       inventory_count AS "inventory",
       priced_count AS "priced sample",
       estimated_count AS "estimated",
       stale_count AS "stale",
       provisional_day AS "provisional"
FROM market_daily_filtered(${dailyArgs})
ORDER BY day`);

const overviewWeekly = grafana(`WITH pooled AS (
  SELECT d.day, d.ppm2
  FROM v_listing_daily d
  WHERE d.price_state = 'valid' AND d.ppm2 IS NOT NULL AND NOT d.is_rent
    AND d.day >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date - 7
    AND d.day < date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date + 7
${dailyFilters("d")}
), weeks AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
           FILTER (WHERE day >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date) AS "this wk",
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
           FILTER (WHERE day >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date - 7
                   AND day < date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date) AS "last wk"
  FROM pooled
)
SELECT "this wk"::int AS "this wk",
       "last wk"::int AS "last wk",
       round((100.0 * ("this wk" - "last wk") / NULLIF("last wk", 0))::numeric, 1)::double precision AS "Δ %"
FROM weeks`);

const currentListingCall =
  "listings_filtered(ARRAY[__CATEGORY__], NULLIF('__MIN__', '')::numeric, NULLIF('__MAX__', '')::numeric, ARRAY[__NEIGHBORHOOD__], false)";

const priceDrops = grafana(`SELECT count(DISTINCT pc.article_id) AS dropped
FROM v_listing_price_changes pc
JOIN ${currentListingCall} l
  ON l.article_id = pc.article_id
WHERE pc.delta < 0
  AND pc.effective_at > now() - INTERVAL '7 days'
  AND pc.deal = ANY (${dealArray})
${currentFilters("l")}`);

const recentDrops =
  grafana(`SELECT l.title, l.url, pc.prior_price AS was, pc.price AS now,
       (pc.prior_price - pc.price) AS drop, pc.effective_at AS seen
FROM v_listing_price_changes pc
JOIN ${currentListingCall} l
  ON l.article_id = pc.article_id
WHERE pc.delta < 0
  AND pc.deal = ANY (${dealArray})
${currentFilters("l")}
ORDER BY pc.effective_at DESC
LIMIT 50`);

const biggestCuts = grafana(`WITH cuts AS (
  SELECT pc.article_id, max(-pc.delta) AS biggest
  FROM v_listing_price_changes pc
  WHERE pc.delta < 0 AND pc.deal = ANY (${dealArray})
  GROUP BY pc.article_id
)
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.biggest)
FROM cuts c
JOIN ${currentListingCall} l
  ON l.article_id = c.article_id
WHERE TRUE
${currentFilters("l")}`);

const activeCutCount = grafana(`WITH cuts AS (
  SELECT DISTINCT pc.article_id
  FROM v_listing_price_changes pc
  WHERE pc.delta < 0 AND pc.deal = ANY (${dealArray})
)
SELECT count(*)::text
FROM cuts c
JOIN ${currentListingCall} l
  ON l.article_id = c.article_id
WHERE TRUE
${currentFilters("l")}`);

const exitsAsking =
  grafana(`SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,
       median AS "asking KM/m2 (daily inventory)",
       priced_count AS "priced sample",
       estimated_count AS "estimated",
       stale_count AS "stale",
       provisional_day AS "provisional"
FROM market_daily_filtered(${dailyArgs})
ORDER BY day`);

const exitsWeekly = grafana(`WITH daily AS (
  SELECT d.day,
         count(*)::numeric AS inventory,
         count(*) FILTER (WHERE d.price_state = 'valid')::numeric AS priced
  FROM v_listing_daily d
  WHERE d.day BETWEEN date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo')
                  AND date($__timeTo() AT TIME ZONE 'Europe/Sarajevo')
${dailyFilters("d")}
  GROUP BY d.day
), weekly AS (
  SELECT date_trunc('week', day::timestamp)::date AS week,
         avg(inventory) AS inventory,
         avg(priced) AS priced
  FROM daily GROUP BY 1
)
SELECT week::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,
       round(100.0 * priced / NULLIF(inventory, 0), 2) AS "sell-through %"
FROM weekly ORDER BY week`);

const homeWeekly = `WITH pooled AS (
  SELECT d.day, d.ppm2
  FROM v_listing_daily d
  WHERE d.price_state = 'valid' AND d.ppm2 IS NOT NULL AND NOT d.is_rent
    AND d.day >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date - 7
    AND d.day < date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date + 7
), weeks AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
           FILTER (WHERE day >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date) AS "this wk",
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
           FILTER (WHERE day >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date - 7
                   AND day < date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date) AS "last wk"
  FROM pooled
)
SELECT "this wk"::int AS "this wk",
       "last wk"::int AS "last wk",
       round((100.0 * ("this wk" - "last wk") / NULLIF("last wk", 0))::numeric, 1)::double precision AS "Δ %"
FROM weeks`;

function findPanel(dashboard, id) {
  return dashboard.panels.find((panel) => panel.id === id);
}

function setSql(panel, sql, targetIndex = 0) {
  panel.targets[targetIndex].rawSql = sql;
}

function updateDashboard(file, update) {
  const fullPath = path.join(dashboardDir, file);
  const dashboard = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  dashboard.timezone = "Europe/Sarajevo";
  update(dashboard);
  fs.writeFileSync(fullPath, `${JSON.stringify(dashboard, null, 2)}\n`);
}

updateDashboard("olx-overview.json", (d) => {
  setSql(findPanel(d, 3), priceDrops);
  setSql(findPanel(d, 7), overviewDaily);
  setSql(findPanel(d, 17), recentDrops);
  setSql(findPanel(d, 19), activeCutCount);
  setSql(findPanel(d, 20), biggestCuts);
  setSql(findPanel(d, 28), overviewWeekly);
  setSql(
    findPanel(d, 10),
    `SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,
       new_n AS "new", closed_n AS "closed", reopened_n AS "reopened",
       active_est AS "active (est)", stale_n AS "stale", provisional_day AS "provisional"
FROM v_market_daily
WHERE day BETWEEN date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo')
              AND date($__timeTo() AT TIME ZONE 'Europe/Sarajevo')
ORDER BY day`,
  );
  setSql(
    findPanel(d, 8),
    grafana(`SELECT room_bucket(l.rooms) AS bucket, count(*) AS listings
FROM listings_filtered(ARRAY[__CATEGORY__], NULLIF('__MIN__', '')::numeric, NULLIF('__MAX__', '')::numeric, ARRAY[__NEIGHBORHOOD__]) l
WHERE NOT l.is_rent
  AND CASE WHEN l.is_rent THEN 'rent' ELSE 'sell' END = ANY (ARRAY[__DEAL__])
${currentFilters("l", false)}
GROUP BY 1 ORDER BY 1`),
  );
  for (const id of [21, 22, 29, 30]) {
    const panel = findPanel(d, id);
    panel.targets[0].rawSql = panel.targets[0].rawSql.replace(
      /(?=\nGROUP BY|\nORDER BY)/,
      "\n  AND CASE WHEN l.is_rent THEN 'rent' ELSE 'sell' END = ANY (ARRAY[${deal:sqlstring}])",
    );
  }
  setSql(
    findPanel(d, 27),
    grafana(
      findPanel(d, 27).targets[0].rawSql.replaceAll(
        "AND room_bucket(l.rooms) = ANY (ARRAY[${rooms:sqlstring}])",
        "AND room_bucket(l.rooms) = ANY (ARRAY[${rooms:sqlstring}])\n    AND CASE WHEN l.is_rent THEN 'rent' ELSE 'sell' END = ANY (ARRAY[${deal:sqlstring}])",
      ),
    ),
  );
  findPanel(d, 7).description =
    "Pooled reconstructed daily inventory asking prices for the selected period. Percentiles are NULL when no eligible priced rows exist; sample, estimated, stale and provisional columns expose data quality.";
  findPanel(d, 10).description =
    "All-category lifecycle flow from historical state observations. Bars: new / closed / reopened; line: estimated live inventory. Historical daily rows may be stale or inferred, and today is provisional.";
  findPanel(d, 28).description =
    "Pooled eligible listing-day asking prices from reconstructed daily inventory, comparing this week with last week. Empty priced populations remain NULL; filters apply to historical category, deal, room, area and neighborhood state.";
  for (const variable of d.templating.list) {
    if (variable.name === "category") {
      variable.definition = variable.query =
        "SELECT category AS __value, category AS __text FROM (SELECT category FROM saved_searches WHERE category IS NOT NULL UNION SELECT unnest(category_memberships) FROM listing_daily) s WHERE category IS NOT NULL GROUP BY category ORDER BY 1";
    }
    if (variable.name === "rooms") {
      variable.definition = variable.query =
        "SELECT bucket AS __value, bucket AS __text FROM (SELECT room_bucket(rooms) AS bucket FROM v_active_listings UNION SELECT room_bucket(rooms) FROM v_listing_daily WHERE rooms IS NOT NULL) s WHERE bucket IS NOT NULL GROUP BY bucket ORDER BY 1";
    }
    if (variable.name === "neighborhood") {
      variable.definition = variable.query =
        "SELECT neighborhood AS __value, neighborhood AS __text FROM (SELECT neighborhood FROM v_listing_daily WHERE neighborhood IS NOT NULL UNION SELECT '(no pin)') s GROUP BY neighborhood ORDER BY 1";
    }
  }
});

updateDashboard("olx-exits.json", (d) => {
  setSql(findPanel(d, 6), exitsAsking, 1);
  setSql(findPanel(d, 16), exitsWeekly);
  findPanel(d, 6).description =
    "Green line: exit askings of ads that closed. Blue: pooled reconstructed daily inventory asking median for the selected filters. Estimated, stale and provisional fields expose historical availability quality.";
  findPanel(d, 16).description =
    "Weekly priced-share proxy from filtered reconstructed listing-day inventory. It is not a transaction rate; inferred, stale and provisional rows are part of the historical availability model.";
  for (const variable of d.templating.list) {
    if (variable.name === "category") {
      variable.definition = variable.query =
        "SELECT category AS __value, category AS __text FROM (SELECT category FROM saved_searches WHERE category IS NOT NULL UNION SELECT unnest(category_memberships) FROM listing_daily) s WHERE category IS NOT NULL GROUP BY category ORDER BY 1";
    }
    if (variable.name === "rooms") {
      variable.definition = variable.query =
        "SELECT bucket AS __value, bucket AS __text FROM (SELECT room_bucket(rooms) AS bucket FROM v_active_listings UNION SELECT room_bucket(rooms) FROM v_listing_daily WHERE rooms IS NOT NULL) s WHERE bucket IS NOT NULL GROUP BY bucket ORDER BY 1";
    }
    if (variable.name === "neighborhood") {
      variable.definition = variable.query =
        "SELECT neighborhood AS __value, neighborhood AS __text FROM (SELECT neighborhood FROM v_listing_daily WHERE neighborhood IS NOT NULL UNION SELECT '(no pin)') s GROUP BY neighborhood ORDER BY 1";
    }
  }
});

updateDashboard("olx-home.json", (d) => {
  setSql(findPanel(d, 7), homeWeekly);
  setSql(
    findPanel(d, 13),
    `SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time, new_n, closed_n, reopened_n, active_est, stale_n, provisional_day
FROM v_market_daily
WHERE day BETWEEN date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo')
              AND date($__timeTo() AT TIME ZONE 'Europe/Sarajevo')
ORDER BY day`,
  );
  setSql(
    findPanel(d, 14),
    `SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,
       round(100.0 * closed_n / NULLIF(active_est, 0), 2) AS "sell-through %"
FROM v_market_daily
WHERE day BETWEEN date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo')
              AND date($__timeTo() AT TIME ZONE 'Europe/Sarajevo')
ORDER BY day`,
  );
  findPanel(d, 7).description =
    "All categories and all deals: pooled reconstructed listing-day asking prices, comparing this week with last week. No dashboard filter variables are exposed on Home; NULL means no eligible priced population.";
  findPanel(d, 13).description =
    "All categories and all deals. Historical state flow includes new, closed and reopened observations; active inventory is estimated from reconstructed daily rows and may include stale carry-forward rows.";
  findPanel(d, 14).description =
    "All categories and all deals. This is the same inventory-flow definition shown on Home, expressed as closed observations divided by estimated active inventory; it is not a transaction measure.";
});

updateDashboard("olx-health.json", (d) => {
  const row = findPanel(d, 20);
  row.gridPos.y += 5;
  for (const id of [21, 22]) findPanel(d, id).gridPos.y += 5;
  d.panels.push(
    {
      type: "row",
      title: "Refactor data quality",
      id: 23,
      gridPos: { h: 1, w: 24, x: 0, y: 50 },
      panels: [],
    },
    {
      id: 24,
      title: "Incomplete searches · 24 h",
      type: "stat",
      description:
        "Search runs that completed with an incomplete or truncated result set. These observations must not be treated as authoritative inventory closures.",
      gridPos: { h: 4, w: 6, x: 0, y: 51 },
      datasource: { type: "postgres", uid: "olx-postgres" },
      fieldConfig: { defaults: { unit: "short", noValue: "—" }, overrides: [] },
      options: {
        colorMode: "value",
        graphMode: "none",
        reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        textMode: "auto",
      },
      targets: [
        {
          datasource: { type: "postgres", uid: "olx-postgres" },
          editorMode: "code",
          format: "table",
          rawSql:
            "SELECT count(*)::bigint AS incomplete\nFROM scrape_runs\nWHERE is_complete = FALSE\n  AND started_at > now() - INTERVAL '24 hours'",
          refId: "A",
        },
      ],
    },
    {
      id: 25,
      title: "Detail backlog · eligible actives",
      type: "stat",
      description:
        "Active listings seen within the 14-day eligibility window without successful detail enrichment.",
      gridPos: { h: 4, w: 6, x: 6, y: 51 },
      datasource: { type: "postgres", uid: "olx-postgres" },
      fieldConfig: { defaults: { unit: "short", noValue: "—" }, overrides: [] },
      options: {
        colorMode: "value",
        graphMode: "none",
        reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        textMode: "auto",
      },
      targets: [
        {
          datasource: { type: "postgres", uid: "olx-postgres" },
          editorMode: "code",
          format: "table",
          rawSql:
            "SELECT count(*)::bigint AS backlog\nFROM listings\nWHERE closed_at IS NULL\n  AND last_seen > now() - INTERVAL '14 days'\n  AND details_fetched_at IS NULL",
          refId: "A",
        },
      ],
    },
    {
      id: 26,
      title: "Rejected history · 30 d",
      type: "stat",
      description:
        "Canonical price evidence rejected as invalid or conflicting during the last 30 days.",
      gridPos: { h: 4, w: 6, x: 12, y: 51 },
      datasource: { type: "postgres", uid: "olx-postgres" },
      fieldConfig: { defaults: { unit: "short", noValue: "—" }, overrides: [] },
      options: {
        colorMode: "value",
        graphMode: "none",
        reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        textMode: "auto",
      },
      targets: [
        {
          datasource: { type: "postgres", uid: "olx-postgres" },
          editorMode: "code",
          format: "table",
          rawSql:
            "SELECT count(*)::bigint AS rejected\nFROM listing_price_events\nWHERE price_state IN ('invalid', 'conflict')\n  AND ingested_at > now() - INTERVAL '30 days'",
          refId: "A",
        },
      ],
    },
    {
      id: 27,
      title: "Analytics refresh age",
      type: "stat",
      description:
        "Seconds since the last successful listing_daily rebuild. A growing value means pending historical analytics work or a failed refresh.",
      gridPos: { h: 4, w: 6, x: 18, y: 51 },
      datasource: { type: "postgres", uid: "olx-postgres" },
      fieldConfig: { defaults: { unit: "s", noValue: "—" }, overrides: [] },
      options: {
        colorMode: "value",
        graphMode: "none",
        reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
        textMode: "auto",
      },
      targets: [
        {
          datasource: { type: "postgres", uid: "olx-postgres" },
          editorMode: "code",
          format: "table",
          rawSql:
            "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - last_successful_refresh_at)), 0)::bigint AS age_seconds\nFROM analytics_refresh_state\nWHERE scope = 'listing_daily'",
          refId: "A",
        },
      ],
    },
  );
  for (const variable of d.templating.list) {
    if (variable.name === "category") {
      variable.definition = variable.query =
        "SELECT category AS __value, category AS __text FROM (SELECT category FROM saved_searches WHERE category IS NOT NULL UNION SELECT unnest(category_memberships) FROM listing_daily) s WHERE category IS NOT NULL GROUP BY category ORDER BY 1";
    }
  }
});
