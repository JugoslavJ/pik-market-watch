"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "../dashboards");
const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));

test("dashboard definitions keep four identities and only query lean relations", () => {
  assert.equal(files.length, 4);
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const dashboard = JSON.parse(source);
    assert.equal(file, `${dashboard.uid}.json`);
    assert.equal(dashboard.annotations, undefined);
    assert.equal(dashboard.schemaVersion, undefined);
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
      assert.equal(panel.targets.length, 1, `${file}:${panel.id}`);
      const target = panel.targets[0];
      assert.equal(panel.datasource, undefined);
      assert.equal(target.datasource, undefined);
      if (target.panelId !== undefined) {
        assert.equal(target.rawSql, undefined);
        const sourcePanel = dashboard.panels.find(
          (candidate) => candidate.id === target.panelId,
        );
        assert.ok(sourcePanel, `${file}:${panel.id}: missing source panel`);
        assert.match(
          sourcePanel.targets[0].rawSql,
          new RegExp(`\\bAS\\s+${panel.options.reduceOptions.fields}\\b`, "i"),
          `${file}:${panel.id}: source is missing selected field`,
        );
      } else {
        assert.ok(target.rawSql, `${file}:${panel.id}: missing SQL`);
      }
      if (panel.type === "stat")
        assert.ok(panel.options.reduceOptions.fields, `${file}:${panel.id}`);
    }
  }
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
