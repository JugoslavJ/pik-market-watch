import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import {
  FILTER_DIMENSIONS,
  chartHeight,
  chartOption,
  echarts,
  number,
  selectionFor,
  selectsBy,
  unit,
} from "./charts";
import {
  PIN_MISSING,
  cell,
  compact,
  isDate,
  label,
  plain,
  pinScale,
  quantileScale,
} from "./format";
import {
  LANGUAGES,
  boardTitle,
  filterLabel,
  initialLanguage,
  locale,
  navTitle,
  panelText,
  sectionName,
  setLanguage,
  t,
  valueLabel,
} from "./i18n";
import { validAd, openAd } from "./links";
import { tableRows } from "./table";
import "./style.css";

const boot = JSON.parse(
  document.getElementById("viewer-bootstrap").textContent,
);
setLanguage(initialLanguage(), boot.data.translations);
const REPORT = new URLSearchParams(location.search).get("report") === "1";
const REPORT_ROWS = 25;
const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      gcTime: 600000,
    },
  },
});
const EMPTY = [];
const PAGE_SIZE = 25;
const DEFAULT_DAYS = boot.data.defaultDays;
const FILTER_COLUMNS = new Set([...FILTER_DIMENSIONS, "article_id"]);
const HIDDEN_COLUMNS = new Set(["url", "latitude", "longitude"]);
const STATUS_COLUMNS = new Set(["status", "phase"]);
const BOARD_ORDER = [
  "olx-home",
  "olx-buyer",
  "olx-renter",
  "olx-daily",
  "olx-pro",
  "olx-overview",
  "olx-exits",
  "olx-health",
];
const boards = [...boot.boards].sort(
  (a, b) => BOARD_ORDER.indexOf(a.uid) - BOARD_ORDER.indexOf(b.uid),
);
const WINDOWS = [
  [2, "48 h"],
  [7, "7 d"],
  [30, "30 d"],
  [90, "90 d"],
  [180, "180 d"],
  [365, "1 y"],
];
const asArray = (value) => (Array.isArray(value) ? value : [value]);
const filterParams = (selection, cross, days) =>
  new URLSearchParams({
    s: JSON.stringify(selection),
    c: JSON.stringify(cross),
    days: String(days),
  });
// Language and report mode ride along so a copied link opens the same view.
const pageParams = (selection, cross, days, lang, report) => {
  const params = filterParams(selection, cross, days);
  if (lang !== "en") params.set("lang", lang);
  if (report) params.set("report", "1");
  return params;
};
const LISTING_REFERENCE =
  /^(\d{1,12}|https?:\/\/(www\.)?olx\.ba\/artikal\/\d{1,12}([/?#]\S*)?)$/i;

// Commits on blur or Enter, so typing does not refetch on every keystroke.
function DraftInput({ value, label, onCommit, type = "number", min = 0 }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const text = String(draft ?? "").trim();
  const invalid =
    type === "text" && text !== "" && !LISTING_REFERENCE.test(text);
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? t("Use an OLX.ba listing link or number.") : undefined}
      placeholder={
        type === "text" ? t("Paste an OLX.ba link or listing id") : undefined
      }
      type={type}
      min={type === "number" ? min : undefined}
      step={type === "number" ? "any" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (text !== String(value ?? "") && !invalid) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

// Reports draw every panel up front so the whole page prints.
function useVisible(ref) {
  const [visible, setVisible] = useState(REPORT);
  useLayoutEffect(() => {
    if (REPORT) return;
    if (ref.current) {
      const bounds = ref.current.getBoundingClientRect();
      if (bounds.top < innerHeight && bounds.bottom > 0) {
        setVisible(true);
        return;
      }
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return visible;
}

const Plot = memo(function Plot({ panel, rows, selected, onSelect, lang }) {
  const ref = useRef(null),
    instance = useRef(null),
    current = useRef({ rows, onSelect });
  const visible = useVisible(ref);
  current.current = { rows, onSelect };
  useEffect(() => {
    if (!visible) return;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    instance.current = chart;
    chart.on("click", (event) => {
      const { rows, onSelect } = current.current;
      const selection = selectionFor(panel, rows, event);
      if (selection) onSelect(selection.dimension, selection.value);
      else if (panel.type === "scatter" && rows[event.dataIndex]?.url)
        openAd(rows[event.dataIndex].url);
    });
    window.__olxChartInstances ||= new Map();
    window.__olxChartInstances.set(panel.id, chart);
    let firstResize = true;
    const resize = new ResizeObserver(() => {
      if (firstResize) firstResize = false;
      else chart.resize();
    });
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      chart.dispose();
      instance.current = null;
      window.__olxChartInstances.delete(panel.id);
    };
  }, [visible, panel]);
  useEffect(() => {
    if (instance.current) {
      instance.current.setOption(chartOption(panel, rows, selected), {
        notMerge: true,
      });
      instance.current.resize();
      ref.current.dataset.ready = "true";
    }
  }, [panel, rows, selected, visible, lang]);
  return (
    <div className="plot-wrap">
      <div
        className="plot"
        ref={ref}
        aria-label={panelText(panel, "title")}
        style={{ height: chartHeight(panel, rows) }}
      />
      {!rows.length && (
        <p className="empty">{t("No data for these filters")}</p>
      )}
    </div>
  );
});

// jsonb rows lose SQL column order: lead with the title, then labels,
// figures and dates.
function columnLayout(rows) {
  const names = Object.keys(rows[0] || {}).filter(
    (name) => !HIDDEN_COLUMNS.has(name),
  );
  const kind = (name) => {
    if (name === "title") return 0;
    const sample = rows.find((row) => row[name] != null)?.[name];
    if (FILTER_COLUMNS.has(name)) return 1;
    if (typeof sample === "number") return 2;
    return isDate(sample) ? 3 : 1;
  };
  const kinds = Object.fromEntries(names.map((name) => [name, kind(name)]));
  const columns = names
    .map((name, index) => [name, index])
    .sort((a, b) => kinds[a[0]] - kinds[b[0]] || a[1] - b[1])
    .map(([name]) => name);
  return {
    columns,
    numeric: new Set(columns.filter((name) => kinds[name] === 2)),
  };
}

function Cell({ column, row, onSelect }) {
  const value = row[column];
  if (column === "title" && validAd(row.url))
    return (
      <a href={row.url} target="_blank" rel="noreferrer" title={value}>
        {value}
      </a>
    );
  if (FILTER_COLUMNS.has(column))
    return (
      <button className="cell-filter" onClick={() => onSelect(column, value)}>
        {valueLabel(value ?? "unknown")}
      </button>
    );
  if (STATUS_COLUMNS.has(column) && value != null)
    return (
      <span className={"pill pill-" + String(value)}>{valueLabel(value)}</span>
    );
  const text =
    typeof value === "string" ? cell(valueLabel(value)) : cell(value);
  return typeof value === "string" && value.length > 60 ? (
    <span className="long" title={value}>
      {text}
    </span>
  ) : (
    text
  );
}

// Panels also receive `lang` so memoized output re-renders on a language switch.
const ListingTable = memo(function ListingTable({ panel, rows, onSelect }) {
  const ref = useRef(null),
    visible = useVisible(ref);
  const [sort, setSort] = useState(null),
    [page, setPage] = useState(0),
    [search, setSearch] = useState("");
  const { columns, numeric } = useMemo(() => columnLayout(rows), [rows]);
  const filtered = useMemo(
    () => tableRows(rows, search, sort),
    [rows, sort, search],
  );
  useEffect(() => {
    setPage(0);
  }, [rows, search]);
  function exportCsv() {
    const quote = (value) => {
      const text = String(value ?? "").replaceAll('"', '""');
      return (
        '"' +
        (typeof value === "number" ? text : text.replace(/^[=+@-]/, "'$&")) +
        '"'
      );
    };
    const csv = [columns, ...filtered.map((row) => columns.map((c) => row[c]))]
      .map((row) => row.map(quote).join(","))
      .join("\r\n");
    const href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = href;
    link.download =
      panel.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") + ".csv";
    link.click();
    URL.revokeObjectURL(href);
  }
  return (
    <div ref={ref} className="table-wrap">
      {visible && (
        <>
          {!REPORT && (
            <div className="table-tools">
              <input
                aria-label={t("Search table")}
                placeholder={t("Search this table")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span>
                {filtered.length.toLocaleString()} {t("rows")}
              </span>
              <button onClick={exportCsv}>CSV</button>
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className={numeric.has(column) ? "num" : undefined}
                      aria-sort={
                        sort?.column === column
                          ? sort.direction === 1
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      <button
                        onClick={() =>
                          setSort({
                            column,
                            direction:
                              sort?.column === column ? -sort.direction : 1,
                          })
                        }
                      >
                        {label(column)}{" "}
                        {sort?.column === column
                          ? sort.direction === 1
                            ? "↑"
                            : "↓"
                          : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(REPORT
                  ? filtered.slice(0, REPORT_ROWS)
                  : filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                ).map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td
                        key={column}
                        className={numeric.has(column) ? "num" : undefined}
                      >
                        <Cell column={column} row={row} onSelect={onSelect} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="empty">{t("No rows for these filters")}</p>
          )}
          {!REPORT && filtered.length > PAGE_SIZE && (
            <div className="pagination">
              <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
                {t("Previous")}
              </button>
              <span>
                {t("Page")} {page + 1} /{" "}
                {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}
              </span>
              <button
                disabled={(page + 1) * PAGE_SIZE >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("Next")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

// Listing pins, or neighborhood areas when the panel's view asks for them.
const MapPanel = memo(function MapPanel({ panel, rows, onSelect }) {
  const ref = useRef(null),
    mapRef = useRef(null),
    latest = useRef(null),
    [failed, setFailed] = useState(false);
  const visible = useVisible(ref);
  const areas = panel.view?.layer === "areas";
  const scale = useMemo(
    () =>
      areas || panel.value ? quantileScale(rows, panel.value) : pinScale(rows),
    [rows, areas, panel.value],
  );
  latest.current = { rows, scale, onSelect };
  useEffect(() => {
    if (!visible) return;
    let closed = false,
      map;
    import("./maps")
      .then(async (maps) => {
        const shapes = areas ? await maps.loadAreas() : null;
        if (closed) return;
        map = maps.createMap(ref.current, { print: REPORT });
        const draw = (fit) => {
          const { rows, scale, onSelect } = latest.current;
          if (areas)
            maps.updateAreas(map, shapes, rows, scale, fit, (name) =>
              onSelect("neighborhood", name),
            );
          else maps.updatePins(map, rows, fit, scale);
        };
        mapRef.current = { map, draw };
        map.on("load", () => {
          draw(true);
          ref.current.dataset.ready = "true";
        });
      })
      .catch(() => setFailed(true));
    return () => {
      closed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [visible, areas]);
  useEffect(() => {
    if (mapRef.current?.map.isStyleLoaded()) mapRef.current.draw(!areas);
  }, [rows, scale, onSelect, areas]);
  return (
    <div className="map-wrap">
      <div className="map" ref={ref} aria-label={panelText(panel, "title")}>
        {failed && <p className="empty">{t("Map unavailable.")}</p>}
      </div>
      {scale && (
        <div
          className="map-legend"
          aria-label={t(areas ? "Area colors" : "Pin colors")}
        >
          <span>{label(scale.field)}</span>
          {scale.colors.map((color, index) => (
            <span key={color} className="legend-step">
              <i style={{ background: color }} />
              {index === 0
                ? "< " + compact(scale.breaks[0])
                : index === scale.breaks.length
                  ? "≥ " + compact(scale.breaks[index - 1])
                  : compact(scale.breaks[index - 1]) +
                    "–" +
                    compact(scale.breaks[index])}
            </span>
          ))}
          {(areas || scale.missing > 0) && (
            <span className="legend-step">
              <i style={{ background: PIN_MISSING }} />
              {t(areas || panel.value ? "No data" : "Rent or unknown")}
            </span>
          )}
          {!areas && (
            <span className="legend-count">
              {rows.length.toLocaleString()} {t("pins")}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

// A tile's change against the previous window of the same length. The arrow
// and words carry the direction; whether up is good depends on the figure.
function Change({ panel, row }) {
  const now = Number(row?.[panel.field]),
    before = Number(row?.[panel.compare]);
  if (!panel.compare || row?.[panel.compare] == null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0)
    return null;
  const change = (100 * (now - before)) / before;
  const arrow = change > 0.5 ? "▲" : change < -0.5 ? "▼" : "=";
  return (
    <p className="change">
      {arrow} {plain(Math.abs(change), 0)}% {t("vs previous period")}
    </p>
  );
}

const Panel = memo(function Panel({ panel, rows, selected, onSelect, lang }) {
  const stat = panel.type === "big_number";
  const description = panelText(panel, "description");
  return (
    <article
      className={"panel " + (stat ? "stat" : "panel-" + panel.type)}
      data-panel={panel.id}
      style={{ gridColumn: `span ${panel.grid.w}` }}
      title={stat ? description : undefined}
    >
      <h3>{panelText(panel, "title")}</h3>
      {!stat && description && <p className="description">{description}</p>}
      {stat ? (
        <>
          <p className="figure">
            <span className="value">
              {number(rows[0]?.[panel.field], panel)}
            </span>
            {unit(panel) && <span className="unit">{t(unit(panel))}</span>}
          </p>
          <Change panel={panel} row={rows[0]} />
        </>
      ) : panel.type === "table" ? (
        <ListingTable
          panel={panel}
          rows={rows}
          onSelect={onSelect}
          lang={lang}
        />
      ) : panel.type === "map" ? (
        <MapPanel panel={panel} rows={rows} onSelect={onSelect} lang={lang} />
      ) : (
        <Plot
          panel={panel}
          rows={rows}
          selected={selected}
          onSelect={onSelect}
          lang={lang}
        />
      )}
    </article>
  );
});

// Panels that fit only some filter values, such as a sales chart under
// Deal: rent, are left out for the others. Mirrors definitions.fits.
const fits = (panel, selection) =>
  Object.entries(panel.when || {}).every(([name, allowed]) =>
    (selection[name] ?? ["All"]).every((value) =>
      allowed.includes(String(value)),
    ),
  );

// Consecutive panels that share a section render under one heading.
function sectionsOf(panels) {
  const groups = [];
  for (const panel of panels) {
    const last = groups[groups.length - 1];
    if (last && last.name === (panel.section || "")) last.panels.push(panel);
    else groups.push({ name: panel.section || "", panels: [panel] });
  }
  return groups;
}

// One control per filter; text filters take an OLX link or id.
function FilterControl({ variable, selection, options, onChange }) {
  const name = filterLabel(variable);
  if (variable.type === "number" || variable.type === "text")
    return (
      <DraftInput
        label={name}
        type={variable.type}
        min={variable.min ?? 0}
        value={selection[variable.name]?.[0] ?? variable.default}
        onCommit={(value) => onChange([value])}
      />
    );
  return (
    <select
      aria-label={name}
      multiple={variable.multi}
      value={
        variable.multi
          ? selection[variable.name]
          : selection[variable.name]?.[0]
      }
      onChange={(e) => {
        const values = [...e.target.selectedOptions].map(
          (option) => option.value,
        );
        onChange(
          values.length > 1
            ? values.filter((value) => value !== "All")
            : values.length
              ? values
              : ["All"],
        );
      }}
    >
      <option value="All">{t("All")}</option>
      {(options[variable.name] || variable.choices)
        .filter((v) => v !== "All")
        .map((value) => (
          <option key={String(value)} value={String(value)}>
            {valueLabel(value)}
          </option>
        ))}
    </select>
  );
}

const changed = (variable, selection) =>
  JSON.stringify(selection[variable.name] || [variable.default]) !==
  JSON.stringify(asArray(variable.default));

// Reports state their scope in words, since the controls are not shown.
function selectionSummary(variables, selection, cross, days) {
  const parts = [
    ...variables
      .filter((variable) => changed(variable, selection))
      .map(
        (variable) =>
          filterLabel(variable) +
          ": " +
          selection[variable.name].map(valueLabel).join(", "),
      ),
    ...Object.entries(cross).map(
      ([dimension, values]) =>
        label(dimension) + ": " + values.map(valueLabel).join(", "),
    ),
  ];
  const window =
    t("Time window:") +
    " " +
    (WINDOWS.find(([value]) => value === days)?.[1] || days + " d");
  return parts.length
    ? t("Selection") + " — " + parts.join(" · ") + " · " + window
    : t("Selection: whole market") + " · " + window;
}

const PREPARER_KEY = "olx-report-preparer";
function readPreparer() {
  try {
    return JSON.parse(localStorage.getItem(PREPARER_KEY)) || {};
  } catch {
    return {};
  }
}

// The "Prepared by" block lives only in this browser and prints on the cover.
function ReportTools({ preparer, onChange, backHref }) {
  const [error, setError] = useState("");
  const update = (patch) => {
    const next = { ...preparer, ...patch };
    onChange(next);
    try {
      localStorage.setItem(PREPARER_KEY, JSON.stringify(next));
    } catch {
      // A private window keeps the block for this page only.
    }
  };
  return (
    <div className="report-tools">
      <a href={backHref}>← {t("Back to dashboard")}</a>
      <fieldset>
        <legend>{t("Prepared by")}</legend>
        {[
          ["name", t("Name")],
          ["company", t("Company")],
          ["contact", t("Contact")],
        ].map(([field, text]) => (
          <label key={field}>
            {text}
            <input
              value={preparer[field] || ""}
              maxLength={120}
              onChange={(e) => update({ [field]: e.target.value })}
            />
          </label>
        ))}
        <label>
          {t("Logo")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (!file.type.startsWith("image/") || file.size > 200000) {
                setError(t("Logo must be an image under 200 KB."));
                return;
              }
              setError("");
              const reader = new FileReader();
              reader.onload = () => update({ logo: reader.result });
              reader.readAsDataURL(file);
            }}
          />
        </label>
        {preparer.logo && (
          <button onClick={() => update({ logo: undefined })}>
            {t("Remove logo")}
          </button>
        )}
        <small>
          {error || t("Stored only in this browser; never sent to the server.")}
        </small>
      </fieldset>
      <button className="primary" onClick={() => window.print()}>
        {t("Print or save as PDF")}
      </button>
    </div>
  );
}

function ReportCover({ data, summary, preparer }) {
  const prepared = preparer.name || preparer.company || preparer.contact;
  return (
    <div className="report-cover">
      <div>
        <p className="eyebrow">OLX Market Watch · {t("Market report")}</p>
        <h1>{boardTitle(data.title)}</h1>
        <p>{summary}</p>
        <p>
          {t("Data as of")}{" "}
          {new Date(data.asOf).toLocaleString(locale(), {
            dateStyle: "long",
            timeStyle: "short",
          })}
        </p>
        <p className="caveat">
          {t("Observed OLX.ba asking prices. Exits are not confirmed sales.")}
        </p>
      </div>
      {(prepared || preparer.logo) && (
        <div className="preparer">
          {preparer.logo && <img src={preparer.logo} alt="" />}
          <p className="eyebrow">{t("Prepared by")}</p>
          {preparer.name && <strong>{preparer.name}</strong>}
          {preparer.company && <span>{preparer.company}</span>}
          {preparer.contact && <span>{preparer.contact}</span>}
        </div>
      )}
    </div>
  );
}

const FOOTER =
  "Data collected from OLX.ba listings. Prices are asking prices in KM; an exit means a listing left the site, not that it sold.";

function App() {
  const [selection, setSelection] = useState(boot.data.selection),
    [cross, setCross] = useState(boot.data.cross),
    [days, setDays] = useState(boot.data.days),
    [lang, setLang] = useState(initialLanguage),
    [preparer, setPreparer] = useState(readPreparer);
  const [force, setForce] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false),
    [filterSearch, setFilterSearch] = useState("");
  const filtersButton = useRef(null);
  const closeFilters = useCallback(() => {
    setFiltersOpen(false);
    filtersButton.current?.focus();
  }, []);
  useEffect(() => {
    if (!filtersOpen) return;
    const escape = (event) => {
      if (event.key === "Escape") closeFilters();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [filtersOpen, closeFilters]);
  const initial =
    JSON.stringify([selection, cross, days]) ===
    JSON.stringify([boot.data.selection, boot.data.cross, boot.data.days]);
  const query = useQuery({
    queryKey: ["dashboard", boot.data.uid, selection, cross, days],
    initialData: initial ? boot.data : undefined,
    staleTime: boot.data.ttl * 1000,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const params = filterParams(selection, cross, days);
      if (force) params.set("force", "true");
      const response = await fetch(
        `/olx/api/dashboard/${boot.data.uid}?${params}`,
        { signal },
      );
      if (response.status === 401) {
        const error = await response.json();
        throw Object.assign(new Error(t(error.message)), {
          loginUrl: error.loginUrl,
        });
      }
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? t("Dashboard access is unavailable.")
            : t("Could not update the dashboard. Retry refresh."),
        );
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error(t("Please sign in again to update the dashboard."));
      return response.json();
    },
  });
  const data = query.data || boot.data;
  useEffect(() => {
    if (query.error?.loginUrl) closeFilters();
  }, [query.error, closeFilters]);
  // Preserve panel objects as filters change so chart instances stay mounted.
  const panels = boot.data.panels;
  const sections = useMemo(
    () => sectionsOf(panels.filter((panel) => fits(panel, selection))),
    [panels, selection],
  );
  // Filters that belong to a section (the price check) render above it.
  const sidebarVariables = data.variables.filter((v) => !v.section);
  const activeFilters =
    sidebarVariables.filter((variable) => changed(variable, selection)).length +
    Object.keys(cross).length;
  const onSelect = useCallback(
    (dimension, value) =>
      setCross((previous) => {
        const next = { ...previous };
        if (JSON.stringify(next[dimension]) === JSON.stringify([value]))
          delete next[dimension];
        else next[dimension] = [value];
        return next;
      }),
    [],
  );
  const setVariable = (name) => (values) =>
    setSelection((s) => ({ ...s, [name]: values }));
  useEffect(() => {
    history.replaceState(
      null,
      "",
      "?" + pageParams(selection, cross, days, lang, REPORT),
    );
  }, [selection, cross, days, lang]);
  useEffect(() => {
    window.__olxViewer = {
      fetching: query.isFetching,
      ready: !query.isPlaceholderData,
      uid: data.uid,
      queries: data.queries,
      sources: data.sources,
      queryMs: data.queryMs,
      cached: data.cached,
      selection,
      cross,
      asOf: data.asOf,
      lang,
      report: REPORT,
    };
    document.documentElement.dataset.viewerReady = "true";
    performance.mark("olx-viewer-render");
  }, [data, query.isFetching, query.isPlaceholderData, selection, cross, lang]);
  useEffect(() => {
    document.title = boardTitle(data.title);
    document.documentElement.classList.toggle("report", REPORT);
  }, [data.title, lang]);
  async function refresh() {
    setForce(true);
    // Invalidate every filter state so revisiting a selection uses fresh data.
    await client.invalidateQueries({
      queryKey: ["dashboard", boot.data.uid],
      refetchType: "none",
    });
  }
  useEffect(() => {
    if (force) query.refetch().finally(() => setForce(false));
  }, [force]);
  function changeLanguage(next) {
    setLanguage(next, boot.data.translations);
    setLang(next);
  }
  const sectionList = (
    <div className={query.isFetching ? "sections busy" : "sections"}>
      {sections.map((section) => {
        const inline = REPORT
          ? []
          : data.variables.filter((v) => v.section === section.name);
        return (
          <section
            className="dash-section"
            key={section.name + section.panels[0].id}
            aria-label={sectionName(section.name) || undefined}
          >
            {section.name && <h2>{sectionName(section.name)}</h2>}
            {!!inline.length && (
              <div className="section-filters">
                {inline.map((variable) => (
                  <label key={variable.name}>
                    {filterLabel(variable)}
                    <FilterControl
                      variable={variable}
                      selection={selection}
                      options={data.options}
                      onChange={setVariable(variable.name)}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="grid">
              {section.panels.map((panel) => (
                <Panel
                  key={panel.id}
                  panel={panel}
                  rows={data.rows[panel.key] || EMPTY}
                  selected={cross[selectsBy(panel)]}
                  onSelect={onSelect}
                  lang={lang}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
  if (REPORT)
    return (
      <>
        <ReportTools
          preparer={preparer}
          onChange={setPreparer}
          backHref={"?" + pageParams(selection, cross, days, lang, false)}
        />
        <main className="report-page">
          <ReportCover
            data={data}
            preparer={preparer}
            summary={selectionSummary(data.variables, selection, cross, days)}
          />
          {query.error && (
            <p role="alert" className="error">
              {query.error.message}
            </p>
          )}
          {sectionList}
        </main>
        <footer>{t(FOOTER)}</footer>
      </>
    );
  return (
    <>
      <header>
        <a className="brand" href="/olx/dashboard/olx-home/">
          <span className="brand-mark" aria-hidden="true" />
          OLX Market Watch
        </a>
        <nav>
          {boards.map((board) => (
            <a
              key={board.uid}
              className={board.uid === data.uid ? "active" : ""}
              href={
                `/olx/dashboard/${encodeURIComponent(board.uid)}/` +
                (lang === "en" ? "" : "?lang=" + lang)
              }
            >
              {navTitle(board)}
            </a>
          ))}
        </nav>
        <div className="segmented" role="group" aria-label={t("Language")}>
          {Object.entries(LANGUAGES).map(([code, text]) => (
            <button
              key={code}
              aria-pressed={lang === code}
              onClick={() => changeLanguage(code)}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="account">
          {/* Superset's own pages manage accounts and roles. */}
          {boot.admin && (
            <a className="button" href="/users/">
              {t("Users")}
            </a>
          )}
          <a className="button" href="/logout/">
            {t("Sign out")}
          </a>
        </div>
      </header>
      <main>
        <div className="heading">
          <div>
            <h1>
              {boardTitle(data.title)
                .replace("OLX.ba ", "")
                .replace("OLX ", "")}
            </h1>
            <p className="eyebrow">
              {t(
                "Observed OLX.ba asking prices. Exits are not confirmed sales.",
              )}
            </p>
          </div>
          <div className="freshness">
            <span role="status" className={query.isFetching ? "busy" : ""}>
              {query.isFetching
                ? t("Updating…")
                : t("Updated") +
                  " " +
                  new Date(data.asOf).toLocaleTimeString(locale(), {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
            </span>
            <div
              className="segmented"
              role="group"
              aria-label={t("Time window")}
            >
              {WINDOWS.map(([value, text]) => (
                <button
                  key={value}
                  aria-pressed={days === value}
                  onClick={() => setDays(value)}
                >
                  {text}
                </button>
              ))}
            </div>
            <button
              className="filters-toggle"
              ref={filtersButton}
              aria-expanded={filtersOpen}
              aria-controls="dashboard-filters"
              onClick={() => setFiltersOpen((open) => !open)}
            >
              {t("Filters")}
              {activeFilters ? ` (${activeFilters})` : ""}
            </button>
            <a
              className="button"
              href={"?" + pageParams(selection, cross, days, lang, true)}
              title={t("Open a printable report")}
            >
              {t("Report")}
            </a>
            <button
              onClick={refresh}
              disabled={query.isFetching}
              aria-label={t("Refresh")}
              title={t("Refresh data")}
            >
              ↻
            </button>
          </div>
        </div>
        <div
          className={"dashboard-layout" + (filtersOpen ? " filters-open" : "")}
        >
          {filtersOpen && (
            <button
              className="filter-backdrop"
              aria-label={t("Close filter panel")}
              onClick={closeFilters}
            />
          )}
          <aside
            id="dashboard-filters"
            className="filter-panel"
            aria-label={t("Dashboard filters")}
            hidden={!filtersOpen}
          >
            <div className="filter-panel-heading">
              <h2>{t("Filters")}</h2>
              <button aria-label={t("Collapse filters")} onClick={closeFilters}>
                ×
              </button>
            </div>
            <input
              className="filter-search"
              aria-label={t("Find a filter")}
              placeholder={t("Find a filter…")}
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
            />
            <div className="filters">
              {sidebarVariables
                .filter((variable) =>
                  filterLabel(variable)
                    .toLowerCase()
                    .includes(filterSearch.toLowerCase()),
                )
                .map((variable) => (
                  <label key={variable.name}>
                    {filterLabel(variable)}
                    <FilterControl
                      variable={variable}
                      selection={selection}
                      options={data.options}
                      onChange={setVariable(variable.name)}
                    />
                  </label>
                ))}
              <button
                onClick={() => {
                  setCross({});
                  setDays(DEFAULT_DAYS);
                  setSelection(
                    Object.fromEntries(
                      data.variables.map((v) => [v.name, asArray(v.default)]),
                    ),
                  );
                }}
              >
                {t("Reset filters")}
              </button>
            </div>
          </aside>
          <div className="dashboard-content">
            {!!Object.keys(cross).length && (
              <div className="selections">
                {Object.entries(cross).map(([dimension, values]) => (
                  <button
                    key={dimension}
                    onClick={() =>
                      setCross((previous) => {
                        const next = { ...previous };
                        delete next[dimension];
                        return next;
                      })
                    }
                  >
                    {label(dimension)}: {values.map(valueLabel).join(", ")}{" "}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            {query.error && (
              <p role="alert" className="error">
                {query.error.message}
                {query.error.loginUrl && (
                  <>
                    {" "}
                    <a href={query.error.loginUrl}>{t("Sign in")}</a>
                  </>
                )}
              </p>
            )}
            {sectionList}
          </div>
        </div>
      </main>
      <footer>{t(FOOTER)}</footer>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
