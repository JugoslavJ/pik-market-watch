"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const dashboardDirectory = path.join(root, "grafana", "dashboards");
const dashboards = Object.fromEntries(
  ["olx-buyer.json", "olx-renter.json", "olx-agent.json"].map((file) => [
    file,
    JSON.parse(fs.readFileSync(path.join(dashboardDirectory, file), "utf8")),
  ]),
);

function panels(dashboard) {
  return dashboard.panels.flatMap((panel) => [panel, ...(panel.panels || [])]);
}

function variable(dashboard, name) {
  const found = dashboard.templating.list.find((entry) => entry.name === name);
  assert.ok(found, `${dashboard.uid} is missing ${name}`);
  return found;
}

function sqlPanels(dashboard) {
  return panels(dashboard).filter((panel) =>
    panel.targets?.some((target) => target.rawSql),
  );
}

test("persona dashboards expose the required identity, defaults, and nullable filters", () => {
  const expectations = {
    "olx-buyer.json": ["olx-buyer", "Find a home to buy"],
    "olx-renter.json": ["olx-renter", "Find a home to rent"],
    "olx-agent.json": ["olx-agent", "Agent market desk"],
  };
  for (const [file, dashboard] of Object.entries(dashboards)) {
    assert.deepEqual([dashboard.uid, dashboard.title], expectations[file]);
    assert.equal(
      variable(dashboard, "property_type").current.value,
      "apartments",
    );
    assert.equal(variable(dashboard, "neighborhood").current.value, "$__all");
    assert.equal(variable(dashboard, "neighborhood").allValue, "'__mapped__'");
    assert.match(
      variable(dashboard, "neighborhood").query,
      /COALESCE\(neighborhood, 'unknown'\)/,
    );
    assert.equal(variable(dashboard, "min_price").current.value, "");
    assert.equal(variable(dashboard, "max_price").current.value, "");
    assert.equal(variable(dashboard, "min_score").current.value, "");
    assert.equal(variable(dashboard, "max_score").current.value, "");

    for (const entry of dashboard.templating.list.filter(
      (item) => item.multi,
    )) {
      if (entry.name === "neighborhood") continue;
      assert.equal(
        entry.includeAll,
        true,
        `${dashboard.uid} ${entry.name} must offer Any`,
      );
      assert.equal(
        entry.allValue,
        "'__any__'",
        `${dashboard.uid} ${entry.name} must use a stable Any sentinel`,
      );
    }
  }
});

test("SQL keeps context, scoring, history, freshness, and pagination boundaries explicit", () => {
  for (const dashboard of Object.values(dashboards)) {
    const rawSql = sqlPanels(dashboard)
      .flatMap((panel) => panel.targets.map((target) => target.rawSql))
      .join("\n");
    assert.doesNotMatch(
      rawSql,
      /\$\{(?!__)[A-Za-z_][A-Za-z0-9_]*\}/,
      "SQL variables must be quoted with :sqlstring",
    );
    assert.match(rawSql, /reporting\.within_bounds/);
    assert.match(rawSql, /ARRAY\['__any__'\]/);
    assert.match(
      rawSql,
      /ARRAY\['__mapped__'\].*(?:neighborhood IS NOT NULL|<> 'unknown')/s,
    );
    assert.match(rawSql, /reporting\.freshness/);
    assert.match(rawSql, /count\(f\.last_success_at\) = count\(\*\)/);
    assert.match(rawSql, /reporting\.listing_comparables/);
    assert.match(rawSql, /benchmark_at AS "evaluated at"/);
    assert.match(rawSql, /score_version AS version/);

    const listing = panels(dashboard).find(
      (panel) =>
        /Interesting (listings|rentals)|Listings to review/.test(panel.title) &&
        panel.targets?.length,
    );
    assert.ok(listing);
    assert.match(listing.targets[0].rawSql, /LIMIT 25\s+OFFSET/);
    assert.match(
      listing.targets[0].rawSql,
      /score DESC NULLS LAST, first_seen DESC NULLS LAST, article_id/,
    );
    assert.match(JSON.stringify(listing.fieldConfig), /__all_variables/);

    const market = panels(dashboard).find(
      (panel) =>
        panel.type === "table" &&
        /by neighbourhood|pricing matrix/i.test(panel.title),
    );
    assert.ok(market);
    assert.match(market.title, /market context before price filters/i);
    assert.ok(
      market.targets[0].rawSql.indexOf("market AS MATERIALIZED") <
        market.targets[0].rawSql.indexOf("matches AS MATERIALIZED"),
    );
  }
});

test("persona KPI cards reuse one source query and select their own result field", () => {
  const expectations = {
    "olx-buyer.json": {
      source: "buyer_listing_scope",
      fields: [
        "matches",
        "within_budget",
        "below_benchmark",
        "priced / scored",
      ],
      calls: 2,
    },
    "olx-renter.json": {
      source: "renter_listing_scope",
      fields: [
        "matches",
        "within_budget",
        "below_benchmark",
        "priced / scored",
      ],
      calls: 2,
    },
    "olx-agent.json": {
      source: "agent_listing_scope",
      fields: [
        "matches",
        "priced / scored",
        "median asking rate",
        "reductions",
      ],
      calls: 1,
    },
  };
  for (const [file, expected] of Object.entries(expectations)) {
    const dashboard = dashboards[file];
    const panels = new Map(dashboard.panels.map((panel) => [panel.id, panel]));
    const source = panels.get(2);
    assert.equal(
      source.transformations,
      undefined,
      `${file}: preserve source fields`,
    );
    assert.equal(
      source.options.reduceOptions.fields,
      "matches",
      `${file}: source card field`,
    );
    assert.equal(
      source.targets[0].rawSql.match(
        new RegExp(`reporting\\.${expected.source}\\(`, "g"),
      )?.length,
      expected.calls,
      `${file}: consolidate matching scope calls`,
    );
    for (const field of expected.fields)
      assert.match(
        source.targets[0].rawSql,
        new RegExp(`AS ["']?${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    for (const [id, field] of [
      [2, expected.fields[0]],
      [3, expected.fields[1]],
      [4, expected.fields[2]],
      [5, expected.fields[3]],
    ]) {
      const panel = panels.get(id);
      if (id > 2) {
        assert.equal(
          panel.targets[0].panelId,
          2,
          `${file}: panel ${id} source`,
        );
        assert.equal(
          panel.datasource.uid,
          "-- Dashboard --",
          `${file}: panel ${id} datasource`,
        );
      }
      if (id > 2)
        assert.deepEqual(
          panel.transformations?.[0],
          {
            id: "filterFieldsByName",
            options: { include: { names: [field] } },
          },
          `${file}: panel ${id} selects its source field`,
        );
    }
  }
});

test("Grafana 13 map and scatter definitions use explicit coordinates, manual fields, and contextual links", () => {
  for (const dashboard of Object.values(dashboards)) {
    const map = panels(dashboard).find((panel) => panel.type === "geomap");
    assert.equal(map.pluginVersion, "13.0.2");
    assert.deepEqual(map.options.layers[0].location, {
      mode: "coords",
      latitude: "latitude",
      longitude: "longitude",
    });
    assert.match(map.options.layers[0].config.links[0].url, /__all_variables/);
    assert.match(map.options.layers[0].config.links[0].url, /var-neighborhood/);

    const scatter = panels(dashboard).find((panel) => panel.type === "xychart");
    assert.equal(scatter.pluginVersion, "13.0.2");
    assert.equal(scatter.options.mapping, "manual");
    assert.ok(scatter.options.series[0].x.matcher.options);
    assert.ok(scatter.options.series[0].y.matcher.options);
    assert.match(scatter.fieldConfig.defaults.links[0].url, /__all_variables/);
    assert.match(
      scatter.fieldConfig.defaults.links[1].url,
      /__data\.fields\.url/,
    );
  }
});

test("agent review controls and rental units remain independently visible", () => {
  const agent = dashboards["olx-agent.json"];
  assert.equal(variable(agent, "view").current.value, "below");
  assert.equal(variable(agent, "pricing_position").current.value, "all");
  assert.equal(variable(agent, "review_signals").allValue, "'__any__'");
  const reviewSql = panels(agent).find((panel) =>
    /Listings to review/.test(panel.title),
  ).targets[0].rawSql;
  assert.match(reviewSql, /reporting\.agent_listing_scope\(/);
  assert.match(reviewSql, /\$\{view:sqlstring\}/);
  assert.match(reviewSql, /\$\{pricing_position:sqlstring\}/);
  assert.match(reviewSql, /ARRAY\[\$\{review_signals:sqlstring\}\]/);
  assert.match(reviewSql, /CASE deal WHEN 'rent' THEN 'KM\/month'/);
  assert.match(agent.description, /rent units throughout/);

  const renter = dashboards["olx-renter.json"];
  assert.match(renter.description, /Rental prices are monthly/);
  const detail = panels(renter).find(
    (panel) => panel.title === "Selected listing detail",
  );
  assert.match(detail.targets[0].rawSql, /Total move-in cost unknown/);
  const scatter = panels(renter).find(
    (panel) => panel.title === "Space for the budget",
  );
  assert.equal(
    scatter.targets.length,
    2,
    "renter budget chart includes an optional maximum-budget line",
  );
});
