// Viewer language: English is the source; definition text for other languages
// arrives with the dashboard payload (superset/dashboards/i18n/<lang>.json).
// Serbian Cyrillic is transliterated from the Serbian (Latin) text.
export const LANGUAGES = { en: "EN", sr: "SR", "sr-Cyrl": "СР" };
export const LANGUAGE_NAMES = {
  en: "English",
  sr: "Srpski (latinica)",
  "sr-Cyrl": "Српски (ћирилица)",
};
const LOCALES = { en: "en-GB", sr: "sr-Latn-BA", "sr-Cyrl": "sr-Cyrl-BA" };

const UI = {
  sr: {
    "Observed OLX.ba asking prices. Exits are not confirmed sales.":
      "Praćene oglašene cijene na OLX.ba. Izlazak oglasa nije potvrđena prodaja.",
    "Data collected from OLX.ba listings. Prices are asking prices in KM; an exit means a listing left the site, not that it sold.":
      "Podaci prikupljeni iz oglasa na OLX.ba. Cijene su tražene cijene u KM; izlazak znači da je oglas uklonjen, a ne da je nekretnina prodata.",
    "No data for these filters": "Nema podataka za ove filtere",
    "No rows for these filters": "Nema redova za ove filtere",
    "Search table": "Pretraži tabelu",
    "Search this table": "Pretraži ovu tabelu",
    rows: "redova",
    Previous: "Prethodna",
    Next: "Sljedeća",
    Page: "Strana",
    "Map unavailable.": "Mapa nije dostupna.",
    "Pin colors": "Boje oznaka",
    "Area colors": "Boje područja",
    "Rent or unknown": "Najam ili nepoznato",
    "No data": "Nema podataka",
    pins: "oznaka",
    "Updating…": "Ažuriranje…",
    Updated: "Ažurirano",
    "Time window": "Vremenski period",
    Filters: "Filteri",
    Refresh: "Osvježi",
    "Refresh data": "Osvježi podatke",
    "Close filter panel": "Zatvori filtere",
    "Dashboard filters": "Filteri",
    "Collapse filters": "Sakrij filtere",
    "Find a filter": "Pronađi filter",
    "Find a filter…": "Pronađi filter…",
    All: "Sve",
    "Reset filters": "Poništi filtere",
    "Sign in": "Prijava",
    "Sign out": "Odjava",
    Users: "Korisnici",
    "Dashboard access is unavailable.": "Pristup ovom pregledu nije dostupan.",
    "Could not update the dashboard. Retry refresh.":
      "Pregled nije ažuriran. Pokušajte ponovo.",
    "Please sign in again to update the dashboard.":
      "Prijavite se ponovo da biste ažurirali pregled.",
    Language: "Jezik",
    Report: "Izvještaj",
    "Open a printable report": "Otvori izvještaj za štampu",
    "Print or save as PDF": "Štampaj ili sačuvaj kao PDF",
    "Back to dashboard": "Nazad na pregled",
    "Prepared by": "Pripremio/la",
    Name: "Ime",
    Company: "Agencija / firma",
    Contact: "Kontakt",
    Logo: "Logo",
    "Remove logo": "Ukloni logo",
    "Logo must be an image under 200 KB.":
      "Logo mora biti slika manja od 200 KB.",
    "Stored only in this browser; never sent to the server.":
      "Čuva se samo u ovom pregledniku i ne šalje se na server.",
    "Market report": "Izvještaj o tržištu",
    "Data as of": "Podaci na dan",
    "Selection: whole market": "Izbor: cijelo tržište",
    Selection: "Izbor",
    "Time window:": "Period:",
    "Paste an OLX.ba link or listing id":
      "Zalijepite OLX.ba link ili broj oglasa",
    "Use an OLX.ba listing link or number.":
      "Unesite link OLX.ba oglasa ili broj oglasa.",
    Apply: "Primijeni",
    "Interquartile range": "Interkvartilni raspon",
    ago: "ranije",
    days: "dana",
    "KM/mo": "KM/mj.",
  },
};

const LETTERS = Object.fromEntries(
  [..."abvgdđežzijklmnoprstćufhcčš", "lj", "nj", "dž"].map((latin, index) => [
    latin,
    "абвгдђежзијклмнопрстћуфхцчшљњџ"[index],
  ]),
);
// Names and abbreviations that stay in Latin script.
const KEEP_LATIN = /(OLX(?:\.ba)?|PDF|https?:\/\/\S+)/;

export function toCyrillic(text) {
  return text
    .split(KEEP_LATIN)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/dž|lj|nj|[a-zčćđšž]/gi, (latin) => {
            const cyrillic = LETTERS[latin.toLowerCase()];
            return latin[0] === latin[0].toLowerCase()
              ? cyrillic
              : cyrillic.toUpperCase();
          }),
    )
    .join("");
}

const transliterate = (value) =>
  typeof value === "string"
    ? toCyrillic(value)
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, transliterate(item)]),
      );

UI["sr-Cyrl"] = transliterate(UI.sr);

const cyrillicCache = new WeakMap();
function cyrillicTexts(latin) {
  if (!latin) return {};
  if (!cyrillicCache.has(latin)) cyrillicCache.set(latin, transliterate(latin));
  return cyrillicCache.get(latin);
}

let current = "en";
let texts = {};

export function initialLanguage() {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  let stored = null;
  try {
    stored = localStorage.getItem("olx-viewer-lang");
  } catch {
    // Storage can be unavailable (private windows); fall back to the browser.
  }
  const browser = navigator.language || "";
  const candidate = [
    fromUrl,
    stored,
    /^sr-Cyrl/i.test(browser)
      ? "sr-Cyrl"
      : ["sr", "bs", "hr"].includes(browser.slice(0, 2))
        ? "sr"
        : "en",
  ].find((value) => value && LANGUAGES[value]);
  return candidate || "en";
}

export function setLanguage(language, translations) {
  current = LANGUAGES[language] ? language : "en";
  texts =
    current === "sr-Cyrl"
      ? cyrillicTexts(translations?.sr)
      : translations?.[current] || {};
  document.documentElement.lang = current;
  try {
    localStorage.setItem("olx-viewer-lang", current);
  } catch {
    // Only a convenience; the URL still carries the language.
  }
}

export const language = () => current;
export const locale = () => LOCALES[current];

export function t(text) {
  return UI[current]?.[text] ?? text;
}

const board = () => texts.board || {};
const common = () => texts.common || {};

export function boardTitle(title) {
  return board().title ?? title;
}

export function panelText(panel, field) {
  return board().panels?.[panel.id]?.[field] ?? panel[field];
}

export function sectionName(name) {
  return board().sections?.[name] ?? common().sections?.[name] ?? name;
}

export function filterLabel(variable) {
  const name = variable.property
    ? variable.column.replace(/^__property_/, "")
    : variable.name;
  const own = board().filters?.[name] ?? common().filters?.[name];
  if (own) return own;
  const property = common().properties?.[name];
  if (!property) return variable.label;
  const bound = variable.name.endsWith("_min")
    ? common().bounds?.minimum
    : variable.name.endsWith("_max")
      ? common().bounds?.maximum
      : null;
  return bound ? `${property} ${bound}` : property;
}

// Column headers and axis names; undefined falls back to the English label.
export function columnLabel(column) {
  return board().columns?.[column] ?? common().columns?.[column];
}

// Neighborhood names are data, not translations; Cyrillic spells them in its
// own script. Other data (listing titles, run errors) stays as written.
const PLACE_COLUMNS = new Set(["neighborhood", "location"]);

export function valueLabel(value, column) {
  if (value == null) return value;
  const text = String(value);
  const own = common().values?.[text];
  if (own) return own;
  return current === "sr-Cyrl" && PLACE_COLUMNS.has(column)
    ? toCyrillic(text)
    : text;
}

export function navTitle(board) {
  return (
    common().boards?.[board.uid] ??
    board.title.replace("OLX.ba ", "").replace("OLX ", "")
  );
}
