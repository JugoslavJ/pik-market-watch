// Labels and number formatting shared by cards, charts, tables and map popups.
import { columnLabel, locale } from "./i18n";

const LABELS = {
  ppm2: "KM/m²",
  sqm: "m²",
  area: "Area (m²)",
  price: "Price (KM)",
  median_ppm2: "Median KM/m²",
  median_price: "Median price",
  closing_ppm2: "Final KM/m²",
  closing_price: "Final ask",
  final_asking_price: "Final ask",
  final_change_pct: "Final price change (%)",
  days_listed: "Days listed",
  cycle_opened_at: "Opened",
  closed_at: "Closed",
  first_seen: "First seen",
  last_seen: "Last seen",
  price_date: "Cut on",
  was: "Was",
  now: "Now",
  reduction: "Cut (KM)",
  new_n: "New",
  closed_n: "Closed",
  ok: "OK",
  p25: "25th percentile",
  p75: "75th percentile",
  age_min: "Age (min)",
  avg_s: "Avg (s)",
  max_s: "Max (s)",
  exits_30d: "Exits · 30 d",
  exit_ratio: "Exit share (%)",
  olx_says: "OLX says",
  we_say: "We say",
  search_key: "Search key",
  seller_type: "Seller",
  failure_pattern: "Failure pattern",
  location: "Neighborhood",
};

export function label(column) {
  const translated = columnLabel(column);
  if (translated) return translated;
  if (LABELS[column]) return LABELS[column];
  const text = String(column).replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Formatters follow the viewer language; build each once per locale.
const formatters = new Map();
function formatter(kind, make) {
  const key = kind + "|" + locale();
  if (!formatters.has(key)) formatters.set(key, make(locale()));
  return formatters.get(key);
}
const compactFormat = () =>
  formatter(
    "compact",
    (tag) =>
      new Intl.NumberFormat(tag, {
        notation: "compact",
        maximumSignificantDigits: 3,
      }),
  );

export function compact(value) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : compactFormat().format(Number(value));
}

// Whole numbers for money-sized values, a little precision for small ones.
export function plain(value, decimals) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "—";
  const n = Number(value);
  const digits =
    decimals ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return n.toLocaleString(locale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: decimals ?? 0,
  });
}

export function duration(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  let minutes = Math.round(Number(value) / (unit === "seconds" ? 60 : 1));
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  minutes %= 60;
  if (days) return `${days} d ${hours} h`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;
const dayFormat = () =>
  formatter(
    "day",
    (tag) =>
      new Intl.DateTimeFormat(tag, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
  );
const timeFormat = () =>
  formatter(
    "time",
    (tag) =>
      new Intl.DateTimeFormat(tag, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
  );

export function isDate(value) {
  return typeof value === "string" && DATE.test(value);
}

export function date(value) {
  // Bare dates are calendar days; parsing them as UTC would shift west of GMT.
  if (value.length === 10) {
    const [y, m, d] = value.split("-").map(Number);
    return dayFormat().format(new Date(y, m - 1, d));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timeFormat().format(parsed);
}

export function cell(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return plain(value);
  if (isDate(value)) return date(value);
  return String(value);
}

// Sequential pin colors on the dark basemap: dim for cheap, bright for expensive.
export const PIN_COLORS = [
  "#1c5cab",
  "#2a78d6",
  "#5598e7",
  "#86b6ef",
  "#cde2fb",
];
export const PIN_MISSING = "#6b7785";
const PIN_FIELDS = ["ppm2", "closing_ppm2"];

export function pinScale(rows) {
  const field = PIN_FIELDS.find((name) =>
    rows.some((row) => Number(row[name]) > 0),
  );
  return field ? quantileScale(rows, field) : null;
}

// Quintile breaks over positive values; rows without one stay neutral.
export function quantileScale(rows, field) {
  const values = rows
    .map((row) => Number(row[field]))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const at = (q) =>
    values[Math.min(values.length - 1, Math.floor(q * values.length))];
  const breaks = [...new Set([0.2, 0.4, 0.6, 0.8].map(at))];
  return {
    field,
    breaks,
    colors: PIN_COLORS.slice(0, breaks.length + 1),
    missing: rows.length - values.length,
  };
}
