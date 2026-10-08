"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "../dashboards");
const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
const load = (file) =>
  JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

const DASHBOARD_KEYS = [
  "uid",
  "title",
  "description",
  "time_range",
  "filters",
  "panels",
];
const FILTER_KEYS = [
  "name",
  "label",
  "type",
  "multi",
  "options_sql",
  "options",
  "default",
  "section",
];
const PANEL_KEYS = [
  "id",
  "title",
  "description",
  "section",
  "type",
  "layout",
  "sql",
  "source_panel",
  "field",
  "bars",
  "category",
  "value",
  "x",
  "y",
  "view",
  "suffix",
  "decimals",
];
const REQUIRED = {
  big_number: ["field"],
  timeseries: [],
  bar: ["category", "value"],
  table: [],
  map: ["view"],
  scatter: ["x", "y"],
};
const keysWithin = (object, allowed, where) =>
  Object.keys(object).forEach((key) =>
    assert.ok(allowed.includes(key), `${where}: unknown key ${key}`),
  );

test("dashboard definitions keep eight identities and a strict format", () => {
  assert.equal(files.length, 8);
  for (const file of files) {
    const dashboard = load(file);
    keysWithin(dashboard, DASHBOARD_KEYS, file);
    assert.equal(file, `${dashboard.uid}.json`);
    assert.match(dashboard.time_range, /^\d+[dhm]$/);
    for (const filter of dashboard.filters) {
      keysWithin(filter, FILTER_KEYS, `${file}:${filter.name}`);
      assert.ok(
        ["select", "number", "text"].includes(filter.type),
        `${file}:${filter.name}`,
      );
      if (filter.type === "select")
        assert.ok(
          filter.options_sql || filter.options?.length,
          `${file}:${filter.name}: options`,
        );
      else
        assert.ok(
          filter.default !== undefined,
          `${file}:${filter.name}: default`,
        );
    }
    // Section inputs render above their section, so it must exist.
    const sections = new Set(dashboard.panels.map((panel) => panel.section));
    for (const filter of dashboard.filters.filter((item) => item.section))
      assert.ok(
        sections.has(filter.section),
        `${file}:${filter.name}: section ${filter.section}`,
      );
    const ids = new Set();
    for (const panel of dashboard.panels) {
      const where = `${file}:${panel.id}`;
      keysWithin(panel, PANEL_KEYS, where);
      assert.ok(!ids.has(panel.id), `${where}: duplicate id`);
      ids.add(panel.id);
      assert.ok(REQUIRED[panel.type], `${where}: type ${panel.type}`);
      for (const key of REQUIRED[panel.type])
        assert.ok(panel[key] !== undefined, `${where}: ${key}`);
      if (panel.view?.layer !== undefined) {
        assert.equal(panel.view.layer, "areas", `${where}: map layer`);
        assert.ok(panel.value, `${where}: area maps color by a value`);
        assert.match(panel.sql, /\bneighborhood\b/, `${where}: joined by name`);
      }
      for (const key of ["x", "y", "w", "h"])
        assert.ok(Number.isInteger(panel.layout[key]), `${where}: layout`);
      assert.notEqual(
        panel.sql === undefined,
        panel.source_panel === undefined,
        `${where}: sql xor source_panel`,
      );
      if (panel.source_panel !== undefined) {
        const source = dashboard.panels.find(
          (candidate) => candidate.id === panel.source_panel,
        );
        assert.ok(source?.sql, `${where}: missing source panel`);
        assert.match(
          source.sql,
          new RegExp(`\\bAS\\s+${panel.field}\\b`, "i"),
          `${where}: source lacks field`,
        );
      }
    }
  }
});

// Viewer languages besides English must cover every visible definition string.
const i18nDir = path.join(dir, "i18n");
const languages = fs
  .readdirSync(i18nDir)
  .filter((file) => file.endsWith(".json"));
const propertyNames = [
  ...fs
    .readFileSync(path.resolve(__dirname, "../listing_filters.py"), "utf8")
    .matchAll(/^\s*\("([a-z_]+)", "[^"]+", (?:"(?:select|range)"|\[)/gm),
].map((match) => match[1]);

test("every viewer language translates every board string", () => {
  assert.ok(languages.length >= 1);
  assert.ok(propertyNames.length >= 40, "property filter list parsed");
  for (const language of languages) {
    const texts = JSON.parse(
      fs.readFileSync(path.join(i18nDir, language), "utf8"),
    );
    const common = texts.__common;
    for (const name of propertyNames)
      assert.ok(common.properties[name], `${language}: property ${name}`);
    for (const file of files) {
      const dashboard = load(file);
      const own = texts[dashboard.uid];
      const where = `${language}:${dashboard.uid}`;
      assert.ok(own?.title, `${where}: title`);
      assert.ok(common.boards[dashboard.uid], `${where}: navigation`);
      for (const panel of dashboard.panels) {
        if (panel.section)
          assert.ok(
            own.sections?.[panel.section],
            `${where}: section ${panel.section}`,
          );
        assert.ok(own.panels?.[panel.id]?.title, `${where}:${panel.id} title`);
        if (panel.description)
          assert.ok(
            own.panels[panel.id].description,
            `${where}:${panel.id} description`,
          );
      }
      for (const filter of dashboard.filters)
        assert.ok(
          own.filters?.[filter.name] || common.filters[filter.name],
          `${where}: filter ${filter.name}`,
        );
    }
  }
});

test("definition SQL reads lean relations and uses only known macros", () => {
  for (const file of files) {
    const dashboard = load(file);
    const names = new Set(dashboard.filters.map((filter) => filter.name));
    const statements = [
      ...dashboard.panels.map((panel) => panel.sql),
      ...dashboard.filters.map((filter) => filter.options_sql),
    ].filter(Boolean);
    for (const sql of statements) {
      assert.match(sql, /lean\./, file);
      for (const [macro, name] of sql.matchAll(/\$\{([^}]*)\}/g)) {
        if (
          /^time_filter:[\w.]+$/.test(name) ||
          ["time_from", "time_to"].includes(name)
        )
          continue;
        assert.ok(names.has(name), `${file}: unknown macro ${macro}`);
      }
      assert.doesNotMatch(sql, /\$__|:sqlstring/, file);
    }
  }
});

test("every Exits data panel reads persisted close events across reopenings", () => {
  const exits = load("olx-exits.json");
  for (const panel of exits.panels.filter((item) => item.sql)) {
    assert.match(
      panel.sql,
      /lean\.listing_lifecycle_events/,
      `panel ${panel.id}`,
    );
    assert.match(panel.sql, /e\.event_type='closed'/, `panel ${panel.id}`);
    assert.match(
      panel.sql,
      /e\.opened_at AS cycle_opened_at/,
      `panel ${panel.id}`,
    );
    assert.doesNotMatch(
      panel.sql,
      /l\.closed_at IS NOT NULL/,
      `panel ${panel.id}`,
    );
  }
  const sql = (id) => exits.panels.find((panel) => panel.id === id).sql;
  assert.match(sql(4), /e\.occurred_at-e\.opened_at/);
  assert.match(sql(9), /ORDER BY closed_at DESC,event_id DESC/);
});
