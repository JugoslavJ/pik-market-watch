const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Serbian Latin transliterates to Cyrillic letter for letter", async () => {
  const { toCyrillic } = await import("../src/i18n.js");
  assert.equal(
    toCyrillic("Džep, Ljubav i Njiva: šećer, čaj, đak, žuto"),
    "Џеп, Љубав и Њива: шећер, чај, ђак, жуто",
  );
  assert.equal(toCyrillic("LJ NJ DŽ"), "Љ Њ Џ");
  assert.equal(toCyrillic("Medijan KM/m²: 30"), "Медијан КМ/м²: 30");
});

test("brand names and links stay in Latin script", async () => {
  const { toCyrillic } = await import("../src/i18n.js");
  assert.equal(
    toCyrillic("Oglasi na OLX.ba, OLX-a i PDF"),
    "Огласи на OLX.ba, OLX-а и PDF",
  );
  assert.equal(
    toCyrillic("Link https://olx.ba/artikal/1 ovdje"),
    "Линк https://olx.ba/artikal/1 овдје",
  );
});

test("Cyrillic covers every Serbian board string without Latin leftovers", async () => {
  const { toCyrillic } = await import("../src/i18n.js");
  const texts = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../superset/dashboards/i18n/sr.json"),
      "utf8",
    ),
  );
  const strings = [];
  (function walk(value) {
    for (const item of Object.values(value))
      typeof item === "string" ? strings.push(item) : walk(item);
  })(texts);
  for (const text of strings) {
    const leftover = toCyrillic(text)
      .replace(/OLX(\.ba)?|PDF|https?:\/\/\S+/g, "")
      .match(/[A-Za-zčćđšžČĆĐŠŽ]+/);
    assert.equal(leftover, null, `${text}: ${leftover}`);
  }
});

test("Cyrillic spells neighborhood names but leaves other data as written", async () => {
  globalThis.document ??= { documentElement: {} };
  const { setLanguage, valueLabel } = await import("../src/i18n.js");
  const translations = { sr: { common: { values: { sale: "prodaja" } } } };
  setLanguage("sr-Cyrl", translations);
  assert.equal(valueLabel("Obilićevo", "neighborhood"), "Обилићево");
  assert.equal(valueLabel("Pobrđe", "location"), "Побрђе");
  assert.equal(valueLabel("Stan Obilićevo", "title"), "Stan Obilićevo");
  assert.equal(valueLabel("sale", "deal"), "продаја");
  setLanguage("sr", translations);
  assert.equal(valueLabel("Obilićevo", "neighborhood"), "Obilićevo");
  setLanguage("en", translations);
});
