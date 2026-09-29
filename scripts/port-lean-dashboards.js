// Generate staged lean dashboards from the unchanged production dashboards.
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const root = path.join(__dirname, "..", "grafana", "dashboards-lean");
const names = ["home", "overview", "health", "exits"];
const v = (name) => "${" + name + ":sqlstring}";
const arr = (name) => `ARRAY[${v(name)}]::text[]`;
const num = (name) => `NULLIF(${v(name)}, '')::numeric`;
const choice = (name, expr, all = "__any__") =>
  `('${all}' = ANY (${arr(name)}) OR COALESCE(${expr}::text, 'unknown') = ANY (${arr(name)}))`;
const bound = (expr, min, max) =>
  `(${num(min)} IS NULL OR ${expr} >= ${num(min)}) AND (${num(max)} IS NULL OR ${expr} <= ${num(max)})`;
const apiPriceSources = "source='api_price_history'";
const reductions = `WITH prices AS (SELECT article_id, price_date, price, lag(price) OVER (PARTITION BY article_id ORDER BY price_date, id) AS previous_price FROM lean.price_history WHERE price IS NOT NULL AND ${apiPriceSources}), cuts AS (SELECT article_id, price_date, previous_price, price, previous_price - price AS reduction FROM prices WHERE previous_price > price)`;
const flow = `WITH days AS (SELECT generate_series(date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo'), date($__timeTo() AT TIME ZONE 'Europe/Sarajevo'), INTERVAL '1 day')::date AS day), movements AS (SELECT first_seen AS day, 1 AS new_n, 0 AS closed_n FROM lean.listings UNION ALL SELECT closed_at, 0, 1 FROM lean.listings WHERE closed_at IS NOT NULL) SELECT d.day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time, COALESCE(sum(m.new_n),0)::int AS new_n, COALESCE(sum(m.closed_n),0)::int AS closed_n FROM days d LEFT JOIN movements m USING(day) GROUP BY d.day ORDER BY d.day`;
const weekly = `WITH weeks AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) FILTER (WHERE first_seen >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date) AS current_week, percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) FILTER (WHERE first_seen >= date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date - 7 AND first_seen < date_trunc('week', now() AT TIME ZONE 'Europe/Sarajevo')::date) AS prior_week FROM lean.listings WHERE deal = 'sale' AND ppm2 > 0) SELECT round((100 * (current_week / NULLIF(prior_week,0) - 1))::numeric,1) AS change_pct FROM weeks`;
const saleRent = `WITH a AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE deal = 'sale' AND price > 0) AS sale, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE deal = 'rent' AND price > 0) AS rent FROM lean.listings WHERE closed_at IS NULL) SELECT round((1200 * rent / NULLIF(sale,0))::numeric,1) AS gross_yield_pct FROM a`;
const priceTrend = () =>
  `WITH days AS (SELECT g.day::date AS day FROM generate_series(GREATEST(date($__timeFrom() AT TIME ZONE 'Europe/Sarajevo'), (now() AT TIME ZONE 'Europe/Sarajevo')::date - 89), LEAST(date($__timeTo() AT TIME ZONE 'Europe/Sarajevo'), (now() AT TIME ZONE 'Europe/Sarajevo')::date), INTERVAL '1 day') AS g(day)), openings AS (SELECT article_id, first_seen AS opened_at FROM lean.listings UNION ALL SELECT article_id, occurred_at AS opened_at FROM lean.listing_lifecycle_events WHERE event_type='reopened'), cycles AS (SELECT o.article_id,o.opened_at,c.closed_at FROM openings o LEFT JOIN LATERAL (SELECT min(e.occurred_at) AS closed_at FROM lean.listing_lifecycle_events e WHERE e.article_id=o.article_id AND e.event_type='closed' AND e.occurred_at>o.opened_at) c ON TRUE), daily AS (SELECT d.day,p.price/NULLIF(l.sqm,0) AS ppm2 FROM days d JOIN cycles c ON c.opened_at<d.day+1 AND (c.closed_at IS NULL OR c.closed_at>=d.day+1) JOIN lean.listings l ON l.article_id=c.article_id AND l.deal='sale' AND l.sqm>0 JOIN LATERAL (SELECT ph.price FROM lean.price_history ph WHERE ph.article_id=l.article_id AND ph.source='api_price_history' AND ph.price_date<=d.day AND ph.price>0 ORDER BY ph.price_date DESC LIMIT 1) p ON TRUE) SELECT day::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2) AS p25,percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) AS median,percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2) AS p75,count(*) AS listings FROM daily GROUP BY day ORDER BY day`;
const runFresh = `SELECT round(EXTRACT(EPOCH FROM (now() - max(finished_at))) / 60)::int AS minutes_since_success FROM lean.scrape_runs WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL`;
const active = `SELECT * FROM lean.listings WHERE closed_at IS NULL`;
const overviewWhere = `l.closed_at IS NULL AND (${v("deal")} = 'All' OR l.deal = CASE WHEN ${v("deal")} = 'sell' THEN 'sale' ELSE ${v("deal")} END) AND (${v("rooms")} = 'All' OR COALESCE(l.rooms,'unknown') = ${v("rooms")}) AND ('All' = ANY (${arr("neighborhood")}) OR COALESCE(l.neighborhood,'unknown') = ANY (${arr("neighborhood")})) AND (${v("category")} = 'All' OR EXISTS (SELECT 1 FROM lean.saved_searches ss WHERE ss.search_key = ANY(l.search_keys) AND ss.category = ${v("category")})) AND ${bound("l.sqm", "min_sqm", "max_sqm")}`;
const ov = `WITH base AS (SELECT l.* FROM lean.listings l WHERE ${overviewWhere})`;
const ovSelect = (q) => `${ov} ${q}`;

const queries = {
  home: {
    2: `SELECT count(*) AS active FROM lean.listings WHERE closed_at IS NULL`,
    3: `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_sale_ppm2 FROM lean.listings WHERE closed_at IS NULL AND deal='sale' AND ppm2>0`,
    4: `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::numeric,0) AS median_rent FROM lean.listings WHERE closed_at IS NULL AND deal='rent' AND price>0`,
    5: saleRent,
    6: `SELECT round(100.0 * count(*) FILTER (WHERE closed_at > now()-INTERVAL '30 days') / NULLIF(count(*) FILTER (WHERE closed_at IS NULL OR closed_at > now()-INTERVAL '30 days'),0),1) AS exit_ratio FROM lean.listings`,
    7: weekly,
    9: runFresh,
    10: `SELECT count(*) AS failed_24h FROM lean.scrape_runs WHERE status='error' AND started_at>now()-INTERVAL '24 hours'`,
    11: `SELECT coalesce(sum(cards),0) AS cards_24h FROM lean.scrape_runs WHERE status='ok' AND started_at>now()-INTERVAL '24 hours'`,
    13: flow,
    14: `WITH flow AS (${flow}) SELECT time,round(100.0*closed_n/NULLIF((SELECT count(*) FROM lean.listings l WHERE l.first_seen<=flow.time AND (l.closed_at IS NULL OR l.closed_at >= (flow.time AT TIME ZONE 'Europe/Sarajevo')::date)),0),2) AS "closed / observed active %" FROM flow ORDER BY time`,
  },
  overview: {
    1: ovSelect(`SELECT count(*) AS active FROM base`),
    2: ovSelect(
      `SELECT count(*) AS new_7d FROM base WHERE first_seen >= (now() AT TIME ZONE 'Europe/Sarajevo')::date - 7`,
    ),
    3: `${reductions} SELECT count(DISTINCT c.article_id) AS drops FROM cuts c JOIN lean.listings l USING(article_id) WHERE ${overviewWhere} AND c.price_date >= (now() AT TIME ZONE 'Europe/Sarajevo')::date - 7`,
    4: ovSelect(
      `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_sale_ppm2 FROM base WHERE deal='sale' AND ppm2>0`,
    ),
    5: ovSelect(
      `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::numeric,0) AS median_rent FROM base WHERE deal='rent' AND price>0`,
    ),
    7: priceTrend(),
    8: ovSelect(
      `SELECT coalesce(rooms,'unknown') AS rooms,count(*) AS listings FROM base WHERE deal='sale' GROUP BY 1 ORDER BY 2 DESC`,
    ),
    10: flow,
    11: ovSelect(
      `SELECT title,url,price,ppm2,neighborhood,rooms,first_seen,last_seen FROM base ORDER BY first_seen LIMIT 25`,
    ),
    13: ovSelect(
      `SELECT latitude,longitude,title,url,price,sqm,rooms,ppm2,neighborhood AS location,last_seen FROM base WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    ),
    14: ovSelect(
      `SELECT title,url,price,sqm,ppm2,neighborhood,latitude,longitude FROM base WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY last_seen DESC LIMIT 100`,
    ),
    16: ovSelect(
      `SELECT title,url,neighborhood,rooms,sqm,price,ppm2 FROM base WHERE deal='sale' AND ppm2>0 ORDER BY ppm2 LIMIT 25`,
    ),
    17: `${reductions} SELECT l.title,l.url,c.previous_price AS was,c.price AS now,c.reduction,c.price_date FROM cuts c JOIN lean.listings l USING(article_id) WHERE ${overviewWhere} ORDER BY c.price_date DESC LIMIT 25`,
    26: ovSelect(
      `SELECT sqm::float8 AS area,price::float8 AS price,neighborhood,title,url FROM base WHERE deal='sale' AND sqm>0 AND price>0`,
    ),
    19: `${reductions} SELECT count(DISTINCT c.article_id) AS actives FROM cuts c JOIN lean.listings l USING(article_id) WHERE ${overviewWhere}`,
    20: `${reductions} SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY reduction)::numeric,0) AS median_cut FROM cuts WHERE reduction>0`,
    21: ovSelect(
      `SELECT coalesce(rooms,'unknown') AS rooms,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_ppm2 FROM base WHERE deal='sale' AND ppm2>0 GROUP BY 1 ORDER BY 1`,
    ),
    22: ovSelect(
      `SELECT property_type AS segment,count(*) AS listings,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_ppm2 FROM base WHERE deal='sale' AND ppm2>0 GROUP BY 1 ORDER BY 2 DESC`,
    ),
    27: saleRent,
    28: weekly,
    29: ovSelect(
      `SELECT coalesce(floor_num::text,'unknown') AS floor,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_ppm2 FROM base WHERE deal='sale' AND ppm2>0 GROUP BY 1 ORDER BY 1`,
    ),
    30: ovSelect(
      `SELECT coalesce(seller_type,'unknown') AS seller_type,count(*) AS listings,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_ppm2 FROM base WHERE deal='sale' AND ppm2>0 GROUP BY 1 ORDER BY 2 DESC`,
    ),
    32: ovSelect(
      `SELECT coalesce(neighborhood,'unknown') AS neighborhood,count(*) AS listings,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::numeric,0) AS median_ppm2 FROM base WHERE deal='sale' AND ppm2>0 GROUP BY 1 ORDER BY 3 DESC`,
    ),
    24: ovSelect(
      `SELECT coalesce(neighborhood,'unknown') AS neighborhood,count(*) AS listings,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::numeric,0) AS median_price FROM base GROUP BY 1 ORDER BY 2 DESC`,
    ),
    23: ovSelect(
      `SELECT title,url,(extra->>'views')::numeric AS views,sqm,rooms,price FROM base WHERE extra->>'views' ~ '^[0-9]+$' ORDER BY views DESC LIMIT 25`,
    ),
  },
  health: {
    1: `SELECT count(*) AS searches FROM lean.saved_searches`,
    2: `SELECT count(*) AS failed_24h FROM lean.scrape_runs WHERE status='error' AND started_at>now()-INTERVAL '24 hours'`,
    3: `SELECT round(100.0*count(*) FILTER (WHERE status='ok')/NULLIF(count(*) FILTER (WHERE status IN ('ok','error')),0),0) AS success_rate FROM lean.scrape_runs WHERE started_at>now()-INTERVAL '24 hours'`,
    4: `SELECT round(EXTRACT(EPOCH FROM (now()-max(finished_at))))::bigint AS seconds_since_success FROM lean.scrape_runs WHERE status='ok' AND is_complete`,
    5: `SELECT coalesce(sum(cards),0) AS cards_24h FROM lean.scrape_runs WHERE status='ok' AND started_at>now()-INTERVAL '24 hours'`,
    7: `SELECT date_trunc('hour',started_at) AS time,count(*) FILTER (WHERE status='ok') AS ok,count(*) FILTER (WHERE status='error') AS error,count(*) FILTER (WHERE status='running') AS running FROM lean.scrape_runs WHERE $__timeFilter(started_at) GROUP BY 1 ORDER BY 1`,
    8: `SELECT date_trunc('hour',started_at) AS time,round(avg(cards))::int AS "avg cards",round(avg(pages))::int AS "avg pages" FROM lean.scrape_runs WHERE $__timeFilter(started_at) GROUP BY 1 ORDER BY 1`,
    10: `SELECT name,coalesce(category,'(none)') AS category,listing_count AS listings,median_ppm2 AS "median KM/m2",new_count AS new,drop_count AS drops,round(EXTRACT(EPOCH FROM (now()-last_scraped_at))/60)::int AS age_min,url FROM lean.saved_searches WHERE ${v("category")}='All' OR category=${v("category")} ORDER BY last_scraped_at NULLS FIRST`,
    12: `SELECT r.id,coalesce(s.category,'(none)') AS category,r.search_key,r.status,r.pages,r.cards,r.started_at AS started,r.finished_at AS finished,r.error FROM lean.scrape_runs r LEFT JOIN lean.saved_searches s USING(search_key) ORDER BY r.id DESC LIMIT 50`,
    14: `SELECT round(100.0*count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)/NULLIF(count(*),0)) AS pinned_pct FROM lean.listings WHERE closed_at IS NULL`,
    15: `SELECT round(100.0*count(details_fetched_at)/NULLIF(count(*),0)) AS details_pct FROM lean.listings WHERE closed_at IS NULL`,
    16: `SELECT round(100.0*count(*) FILTER (WHERE ppm2>0)/NULLIF(count(*),0)) AS priced_pct FROM lean.listings WHERE closed_at IS NULL`,
    17: `SELECT round(100.0*count(api_status)/NULLIF(count(*),0)) AS api_status_pct FROM lean.listings WHERE closed_at IS NULL`,
    18: `SELECT coalesce(api_status,'(not exposed)') AS olx_says,CASE WHEN closed_at IS NOT NULL THEN 'closed' ELSE 'open' END AS we_say,count(*) AS listings FROM lean.listings WHERE last_seen>now()-INTERVAL '14 days' GROUP BY 1,2 ORDER BY 3 DESC`,
    19: `SELECT s.name,coalesce(s.category,'(none)') AS category,count(r.id) AS runs,round(avg(EXTRACT(EPOCH FROM (r.finished_at-r.started_at))))::int AS avg_s,max(EXTRACT(EPOCH FROM (r.finished_at-r.started_at)))::int AS max_s FROM lean.scrape_runs r JOIN lean.saved_searches s USING(search_key) WHERE r.finished_at IS NOT NULL AND $__timeFilter(r.started_at) GROUP BY 1,2 ORDER BY 4 DESC`,
    21: `SELECT count(*)::int AS runs,left(regexp_replace(coalesce(error,'(no message)'), '[0-9]+','#','g'),120) AS failure_pattern,max(started_at) AS last_seen FROM lean.scrape_runs WHERE status='error' AND started_at>now()-INTERVAL '7 days' GROUP BY 2 ORDER BY 1 DESC`,
    22: `SELECT date_trunc('hour',started_at) AS time,round(avg(EXTRACT(EPOCH FROM (finished_at-started_at)))/60.0,1) AS "avg min",round(max(EXTRACT(EPOCH FROM (finished_at-started_at)))/60.0,1) AS "max min" FROM lean.scrape_runs WHERE finished_at IS NOT NULL AND $__timeFilter(started_at) GROUP BY 1 ORDER BY 1`,
    24: `SELECT count(*) AS incomplete FROM lean.scrape_runs WHERE NOT is_complete AND status IN ('ok','error') AND finished_at IS NOT NULL AND started_at>now()-INTERVAL '24 hours'`,
    25: `SELECT count(*) AS backlog FROM lean.listings WHERE closed_at IS NULL AND (details_fetched_at IS NULL OR details_fetched_at<now()-INTERVAL '7 days') AND (last_enrichment_attempted_at IS NULL OR last_enrichment_attempted_at<now()-INTERVAL '12 hours')`,
    26: `SELECT count(*) AS invalid_latest FROM lean.listings WHERE extra->>'latest_price_state' IN ('invalid','conflict') AND last_seen>now()-INTERVAL '30 days'`,
    28: `SELECT s.name,s.category,s.search_key,CASE WHEN r.status='error' THEN 'failed' WHEN r.status='running' THEN 'running' WHEN r.finished_at<now()-INTERVAL '26 hours' THEN 'stale' ELSE coalesce(r.status,'never') END AS phase,round(EXTRACT(EPOCH FROM (now()-r.finished_at))/60)::int AS age_min,r.started_at,r.finished_at,r.error,s.url FROM lean.saved_searches s LEFT JOIN LATERAL (SELECT * FROM lean.scrape_runs WHERE search_key=s.search_key ORDER BY id DESC LIMIT 1) r ON TRUE WHERE ${v("category")}='All' OR s.category=${v("category")} ORDER BY r.finished_at NULLS FIRST`,
  },
  exits: {},
};

const exitFilter = (alias) =>
  `(${v("deal")}='All' OR ${alias}.deal=CASE WHEN ${v("deal")}='sell' THEN 'sale' ELSE ${v("deal")} END) AND (${v("category")}='All' OR ${alias}.property_type=${v("category")}) AND (${v("rooms")}='All' OR coalesce(${alias}.rooms,'unknown')=${v("rooms")}) AND ('All'=ANY(${arr("neighborhood")}) OR coalesce(${alias}.neighborhood,'unknown')=ANY(${arr("neighborhood")})) AND ${bound(`${alias}.sqm`, "min_sqm", "max_sqm")}`;
const exBase = `WITH base AS (SELECT e.id AS event_id,e.article_id,e.title,e.url,e.deal,e.property_type,e.sqm,e.rooms,e.neighborhood,e.latitude,e.longitude,e.price AS closing_price,e.occurred_at AS closed_at,e.opened_at AS cycle_opened_at,CASE WHEN e.sqm>0 THEN e.price/e.sqm END AS closing_ppm2,(e.occurred_at-e.opened_at) AS days_listed FROM lean.listing_lifecycle_events e WHERE e.event_type='closed' AND ${exitFilter("e")}), active AS (SELECT l.article_id,l.deal,l.property_type,l.rooms,l.sqm,l.ppm2,l.neighborhood FROM lean.listings l WHERE l.closed_at IS NULL AND ${exitFilter("l")})`;
const ex = (q) => `${exBase} ${q}`;
const openingPrice = `JOIN LATERAL (SELECT price AS opening_price FROM lean.price_history WHERE article_id=b.article_id AND source='api_price_history' AND price>0 AND price_date<=b.closed_at ORDER BY CASE WHEN price_date>=b.cycle_opened_at THEN 0 ELSE 1 END,CASE WHEN price_date>=b.cycle_opened_at THEN price_date END ASC NULLS LAST,CASE WHEN price_date<b.cycle_opened_at THEN price_date END DESC NULLS LAST LIMIT 1) opening ON TRUE`;
Object.assign(queries.exits, {
  1: ex(
    `SELECT count(*) AS closed_30d FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30`,
  ),
  2: ex(
    `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY closing_ppm2)::numeric,0) AS median_exit_ppm2 FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30 AND closing_ppm2>0`,
  ),
  3: ex(
    `SELECT round(100.0*(SELECT count(*) FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30)/NULLIF((SELECT count(*) FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30)+(SELECT count(*) FROM active),0),1) AS exit_ratio`,
  ),
  4: ex(
    `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_listed)::numeric,1) AS median_days_on_market FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30`,
  ),
  6: ex(
    `SELECT closed_at::timestamp AT TIME ZONE 'Europe/Sarajevo' AS time,round(percentile_cont(0.5) WITHIN GROUP (ORDER BY closing_ppm2)::numeric,0) AS "median exit KM/m²" FROM base WHERE $__timeFilter(closed_at) GROUP BY 1 ORDER BY 1`,
  ),
  7: ex(
    `SELECT width_bucket(days_listed,0,180,9)::text AS days_bracket,count(*) AS listings FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 90 AND days_listed>=0 GROUP BY 1 ORDER BY 1`,
  ),
  9: ex(
    `SELECT title,url,neighborhood,rooms,sqm,closing_price AS final_asking_price,closing_ppm2,cycle_opened_at,closed_at,round(days_listed::numeric,1) AS days_listed FROM base ORDER BY closed_at DESC,event_id DESC LIMIT 50`,
  ),
  10: ex(
    `SELECT coalesce(rooms,'unknown') AS rooms,count(*) AS exits FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30 GROUP BY 1 ORDER BY 2 DESC`,
  ),
  12: ex(
    `SELECT latitude,longitude,title,url,closing_price,days_listed FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 90 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
  ),
  13: ex(
    `SELECT title,url,neighborhood,latitude,longitude,closing_price,closed_at FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 90 AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY closed_at DESC`,
  ),
  15: ex(
    `SELECT CASE WHEN b.closing_price<opening.opening_price THEN 'lower' WHEN b.closing_price>opening.opening_price THEN 'higher' ELSE 'same' END AS direction,count(*) AS listings FROM base b ${openingPrice} WHERE b.closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 90 AND b.closing_price IS NOT NULL GROUP BY 1`,
  ),
  18: ex(
    `SELECT b.days_listed::float8 AS days_listed, (100.0*(b.closing_price/opening.opening_price-1))::float8 AS final_change_pct,b.title,b.url,b.article_id FROM base b ${openingPrice} WHERE b.closing_price IS NOT NULL`,
  ),
  19: ex(
    `SELECT ppm2_bracket,round(100.0*sum(exits)/NULLIF(sum(exits)+sum(actives),0),1) AS exit_ratio FROM (SELECT (floor(closing_ppm2/1000)*1000)::int AS ppm2_bracket,count(*) AS exits,0::bigint AS actives FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30 AND closing_ppm2>0 GROUP BY 1 UNION ALL SELECT (floor(ppm2/1000)*1000)::int,0,count(*) FROM active WHERE ppm2>0 GROUP BY 1) population GROUP BY ppm2_bracket ORDER BY ppm2_bracket`,
  ),
  20: ex(
    `SELECT neighborhood,sum(exits) AS exits_30d,sum(actives) AS active,round(100.0*sum(exits)/NULLIF(sum(exits)+sum(actives),0),1) AS exit_ratio FROM (SELECT coalesce(neighborhood,'unknown') AS neighborhood,count(*) AS exits,0::bigint AS actives FROM base WHERE closed_at > (now() AT TIME ZONE 'Europe/Sarajevo')::date - 30 GROUP BY 1 UNION ALL SELECT coalesce(neighborhood,'unknown'),0,count(*) FROM active GROUP BY 1) population GROUP BY neighborhood ORDER BY exit_ratio DESC NULLS LAST`,
  ),
});

const dropped = {
  health: new Set([27, 29, 30]),
  exits: new Set([16]),
  overview: new Set([]),
  home: new Set([]),
};
const title = {
  "home:7": "Median KM/m² of newly seen sales · this week vs last",
  "overview:7": "Median reported sale price KM/m² by day",
  "overview:28": "Median KM/m² of newly seen sales · this week vs last",
  "overview:20": "Median recorded price cut · KM",
  "exits:9": "Recently closed · final recorded ask",
  "exits:15": "Final recorded ask vs cycle opening ask",
  "exits:19": "Observed closure share by final KM/m² bracket",
  "exits:3": "Observed closure share · 30 d",
  "health:26": "Listings with invalid latest price state · 30 d",
  "exits:6": "Final asking KM/m² by observed closure day",
};
const statFields = {
  home: {
    2: "active",
    3: "median_sale_ppm2",
    4: "median_rent",
    5: "gross_yield_pct",
    6: "exit_ratio",
    7: "change_pct",
    9: "minutes_since_success",
    10: "failed_24h",
    11: "cards_24h",
  },
  overview: {
    1: "active",
    2: "new_7d",
    3: "drops",
    4: "median_sale_ppm2",
    5: "median_rent",
    19: "actives",
    20: "median_cut",
    27: "gross_yield_pct",
    28: "change_pct",
  },
  health: {
    1: "searches",
    2: "failed_24h",
    3: "success_rate",
    4: "seconds_since_success",
    5: "cards_24h",
    14: "pinned_pct",
    15: "details_pct",
    16: "priced_pct",
    17: "api_status_pct",
    24: "incomplete",
    25: "backlog",
    26: "invalid_latest",
  },
  exits: {
    1: "closed_30d",
    2: "median_exit_ppm2",
    3: "exit_ratio",
    4: "median_days_on_market",
  },
};

function setVariable(variable, name) {
  const key = variable.name;
  if (variable.type !== "query") return;
  let sql;
  if (key === "category")
    sql = `SELECT DISTINCT category AS __value,category AS __text FROM lean.saved_searches WHERE category IS NOT NULL ORDER BY 1`;
  if (key === "property_type")
    sql = `SELECT DISTINCT coalesce(property_type,'unknown') AS __value,coalesce(property_type,'unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (key === "neighborhood")
    sql = `SELECT DISTINCT coalesce(neighborhood,'unknown') AS __value,coalesce(neighborhood,'unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (key === "rooms")
    sql = `SELECT DISTINCT coalesce(rooms,'unknown') AS __value,coalesce(rooms,'unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (key === "condition")
    sql = `SELECT DISTINCT coalesce(condition,'unknown') AS __value,coalesce(condition,'unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (key === "seller_type")
    sql = `SELECT DISTINCT coalesce(seller_type,'unknown') AS __value,coalesce(seller_type,'unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (key === "floor")
    sql = `SELECT DISTINCT coalesce(floor_num::text,'unknown') AS __value,coalesce(floor_num::text,'unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (key === "heating")
    sql = `SELECT DISTINCT coalesce(extra->>'heating','unknown') AS __value,coalesce(extra->>'heating','unknown') AS __text FROM lean.listings WHERE closed_at IS NULL ORDER BY 1`;
  if (!sql) throw new Error(`${name}: no variable SQL for ${key}`);
  variable.query = sql;
  variable.definition = sql;
  if (name === "overview" || name === "exits" || name === "health")
    variable.allValue = "'All'";
}

for (const name of names) {
  const file = path.join(root, `olx-${name}.json`);
  const dash = JSON.parse(
    childProcess.execFileSync(
      "git",
      ["show", `HEAD:grafana/dashboards/olx-${name}.json`],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" },
    ),
  );
  dash.description = `Direct views of current listings, recorded price changes, scrape runs, and observed closures in the lean schema. Historical charts use retained event dates and reported daily prices rather than reconstructed inventory.`;
  dash.links = (dash.links || []).filter(
    (link) => !["Agent", "Buyer", "Renter"].includes(link.title),
  );
  dash.panels = dash.panels.filter(
    (p) =>
      p.type === "row" || (!dropped[name].has(p.id) && queries[name][p.id]),
  );
  for (const p of dash.panels) {
    if (p.type === "row") {
      if (name === "exits" && p.id === 5) p.title = "Observed closure prices";
      continue;
    }
    const sql = queries[name][p.id];
    if (!sql) throw new Error(`Missing ${name}:${p.id}`);
    p.title = title[`${name}:${p.id}`] || p.title;
    p.description =
      "Uses current listing state, observed dates, or recorded price changes from lean tables.";
    p.datasource = { type: "postgres", uid: "olx-postgres" };
    p.targets = [
      {
        datasource: { type: "postgres", uid: "olx-postgres" },
        editorMode: "code",
        format: ["timeseries"].includes(p.type) ? "time_series" : "table",
        rawSql: sql,
        refId: "A",
      },
    ];
    delete p.transformations;
    if (p.type === "geomap")
      for (const layer of p.options.layers || [])
        layer.location = {
          mode: "coords",
          latitude: "latitude",
          longitude: "longitude",
        };
    if (p.type === "bargauge") {
      const fields = {
        overview: {
          8: ["rooms", "listings"],
          21: ["rooms", "median_ppm2"],
          29: ["floor", "median_ppm2"],
        },
        exits: {
          7: ["days_bracket", "listings"],
          10: ["rooms", "exits"],
          15: ["direction", "listings"],
          19: ["ppm2_bracket", "exit_ratio"],
        },
      }[name]?.[p.id];
      if (fields)
        p.transformations = [
          {
            id: "rowsToFields",
            options: { nameField: fields[0], valueField: fields[1] },
          },
        ];
    }
    if (p.type === "xychart") {
      const fields = {
        overview: { 26: ["area", "price"] },
        exits: { 18: ["days_listed", "final_change_pct"] },
      }[name]?.[p.id];
      if (fields) {
        p.options.series = p.options.series.slice(0, 1);
        p.options.series[0].x.matcher.options = fields[0];
        p.options.series[0].y.matcher.options = fields[1];
      }
      for (const series of p.options.series || []) delete series.color;
    }
    if (p.type === "stat") {
      p.options.reduceOptions.fields = statFields[name][p.id];
      if (name === "overview" && p.id === 28)
        p.fieldConfig.defaults.unit = "percent";
      if (name === "overview" && p.id === 19)
        p.fieldConfig.defaults.unit = "short";
    }
    // Old overrides refer to fields from the removed reporting layer.
    if (p.fieldConfig) p.fieldConfig.overrides = [];
  }
  for (const variable of dash.templating.list) setVariable(variable, name);
  if (name === "overview" || name === "exits")
    for (const variable of dash.templating.list)
      if (variable.includeAll) variable.allValue = "'All'";
  for (const annotation of dash.annotations?.list || []) {
    if (annotation.rawSql)
      annotation.rawSql = annotation.rawSql.replace(
        /reporting\.scrape_health/g,
        "lean.scrape_runs",
      );
    if (annotation.target?.rawSql)
      annotation.target.rawSql = annotation.target.rawSql.replace(
        /reporting\.scrape_health/g,
        "lean.scrape_runs",
      );
  }
  fs.writeFileSync(file, JSON.stringify(dash, null, 2) + "\n");
  console.log(
    `${name}: ${dash.panels.filter((p) => p.type !== "row").length} panels`,
  );
}
