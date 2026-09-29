"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "../../../grafana/dashboards-lean");
const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));

test("staged lean dashboards keep four identities and only query lean relations", () => {
  assert.equal(files.length, 4);
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const dashboard = JSON.parse(source);
    assert.equal(file, `${dashboard.uid}.json`);
    assert.doesNotMatch(
      source,
      /\b(?:reporting|olap)\.|analytics_refresh_state|current_listing_scores/,
      file,
    );
    const variables = new Set(
      dashboard.templating.list.map((item) => item.name),
    );
    const sql = [
      ...dashboard.panels.flatMap((panel) =>
        (panel.targets || []).map((target) => target.rawSql || ""),
      ),
      ...dashboard.templating.list
        .filter((item) => item.type === "query")
        .map((item) => item.query),
      ...(dashboard.annotations?.list || []).map(
        (item) => item.rawSql || item.target?.rawSql || "",
      ),
    ];
    for (const statement of sql.filter(Boolean)) {
      assert.match(statement, /lean\./, file);
      for (const [, name] of statement.matchAll(/\$\{([a-z_]+):sqlstring\}/g))
        assert.ok(variables.has(name), `${file}: undefined ${name}`);
      assert.doesNotMatch(statement, /\$\{(?!__)[a-z_]+\}/, file);
    }
    for (const panel of dashboard.panels.filter(
      (item) => item.type !== "row",
    )) {
      assert.equal(panel.datasource.uid, "olx-postgres", `${file}:${panel.id}`);
      assert.equal(panel.targets.length, 1, `${file}:${panel.id}`);
      if (panel.type === "stat")
        assert.ok(panel.options.reduceOptions.fields, `${file}:${panel.id}`);
    }
  }
});

test("staged dashboards retain price and closure evidence while removing refresh health", () => {
  const dashboards = Object.fromEntries(
    files.map((file) => [
      file,
      JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")),
    ]),
  );
  const sql = (file) =>
    dashboards[file].panels
      .flatMap((panel) => panel.targets || [])
      .map((target) => target.rawSql)
      .join("\n");
  assert.match(sql("olx-overview.json"), /lean\.price_history/);
  assert.match(sql("olx-home.json"), /closed_at/);
  assert.match(sql("olx-health.json"), /lean\.scrape_runs/);
  assert.match(sql("olx-exits.json"), /closing_price/);
  for (const source of files.map((file) =>
    fs.readFileSync(path.join(dir, file), "utf8"),
  ))
    assert.doesNotMatch(
      source,
      /neighborhood_stats|benchmark|deviation_pct|\bscore\b/i,
    );
  for (const id of [27, 29, 30])
    assert.equal(
      dashboards["olx-health.json"].panels.find((panel) => panel.id === id),
      undefined,
    );
});

test("every Exits data panel reads persisted close events across reopenings", () => {
  const exits = JSON.parse(
    fs.readFileSync(path.join(dir, "olx-exits.json"), "utf8"),
  );
  for (const panel of exits.panels.filter((item) => item.type !== "row")) {
    const query = panel.targets[0].rawSql;
    assert.match(query, /lean\.listing_lifecycle_events/, `panel ${panel.id}`);
    assert.match(query, /e\.event_type='closed'/, `panel ${panel.id}`);
    assert.match(query, /e\.opened_at AS cycle_opened_at/, `panel ${panel.id}`);
    assert.doesNotMatch(query, /l\.closed_at IS NOT NULL/, `panel ${panel.id}`);
  }
  const duration = exits.panels.find((panel) => panel.id === 4).targets[0]
    .rawSql;
  assert.match(duration, /e\.occurred_at-e\.opened_at/);
  const recent = exits.panels.find((panel) => panel.id === 9).targets[0].rawSql;
  assert.match(recent, /ORDER BY closed_at DESC,event_id DESC/);
});
