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
  unit,
} from "./charts";
import { PIN_MISSING, cell, compact, isDate, label, pinScale } from "./format";
import { validAd, openAd } from "./links";
import { tableRows } from "./table";
import "./style.css";

const boot = JSON.parse(
  document.getElementById("viewer-bootstrap").textContent,
);
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
const BOARD_ORDER = ["olx-home", "olx-overview", "olx-exits", "olx-health"];
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

function AreaInput({ value, label, min = 0, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      type="number"
      min={min}
      step="any"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function useVisible(ref) {
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
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

const Plot = memo(function Plot({ panel, rows, selected, onSelect }) {
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
      const selection = selectionFor(panel, rows, event.dataIndex);
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
  }, [panel, rows, selected, visible]);
  return (
    <div className="plot-wrap">
      <div
        className="plot"
        ref={ref}
        aria-label={panel.title}
        style={{ height: chartHeight(panel, rows) }}
      />
      {!rows.length && <p className="empty">No data for these filters</p>}
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
        {String(value ?? "unknown")}
      </button>
    );
  if (STATUS_COLUMNS.has(column) && value != null)
    return (
      <span className={"pill pill-" + String(value)}>{String(value)}</span>
    );
  const text = cell(value);
  return typeof value === "string" && value.length > 60 ? (
    <span className="long" title={value}>
      {text}
    </span>
  ) : (
    text
  );
}

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
          <div className="table-tools">
            <input
              aria-label="Search table"
              placeholder="Search this table"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span>{filtered.length.toLocaleString()} rows</span>
            <button onClick={exportCsv}>CSV</button>
          </div>
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
                {filtered
                  .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
                  .map((row, index) => (
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
          {!rows.length && <p className="empty">No rows for these filters</p>}
          {filtered.length > PAGE_SIZE && (
            <div className="pagination">
              <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span>
                Page {page + 1} /{" "}
                {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}
              </span>
              <button
                disabled={(page + 1) * PAGE_SIZE >= filtered.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

const Pins = memo(function Pins({ panel, rows }) {
  const ref = useRef(null),
    mapRef = useRef(null),
    latest = useRef(rows),
    [failed, setFailed] = useState(false);
  const visible = useVisible(ref);
  const scale = useMemo(() => pinScale(rows), [rows]);
  latest.current = { rows, scale };
  useEffect(() => {
    if (!visible) return;
    let closed = false,
      map;
    import("./maps")
      .then(({ createMap, updatePins }) => {
        if (closed) return;
        map = createMap(ref.current);
        mapRef.current = { map, updatePins };
        map.on("load", () => {
          updatePins(map, latest.current.rows, true, latest.current.scale);
          ref.current.dataset.ready = "true";
        });
      })
      .catch(() => setFailed(true));
    return () => {
      closed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [visible]);
  useEffect(() => {
    if (mapRef.current?.map.isStyleLoaded())
      mapRef.current.updatePins(mapRef.current.map, rows, true, scale);
  }, [rows, scale]);
  return (
    <div className="map-wrap">
      <div className="map" ref={ref} aria-label={panel.title}>
        {failed && <p className="empty">Map unavailable.</p>}
      </div>
      {scale && (
        <div className="map-legend" aria-label="Pin colors">
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
          {scale.missing > 0 && (
            <span className="legend-step">
              <i style={{ background: PIN_MISSING }} />
              Rent or unknown
            </span>
          )}
          <span className="legend-count">
            {rows.length.toLocaleString()} pins
          </span>
        </div>
      )}
    </div>
  );
});

const Panel = memo(function Panel({ panel, rows, selected, onSelect }) {
  const stat = panel.type === "big_number";
  return (
    <article
      className={"panel " + (stat ? "stat" : "panel-" + panel.type)}
      data-panel={panel.id}
      style={{ gridColumn: `span ${panel.grid.w}` }}
      title={stat ? panel.description : undefined}
    >
      <h3>{panel.title}</h3>
      {!stat && panel.description && (
        <p className="description">{panel.description}</p>
      )}
      {stat ? (
        <p className="figure">
          <span className="value">{number(rows[0]?.[panel.field], panel)}</span>
          {unit(panel) && <span className="unit">{unit(panel)}</span>}
        </p>
      ) : panel.type === "table" ? (
        <ListingTable panel={panel} rows={rows} onSelect={onSelect} />
      ) : panel.type === "map" ? (
        <Pins panel={panel} rows={rows} />
      ) : (
        <Plot
          panel={panel}
          rows={rows}
          selected={selected}
          onSelect={onSelect}
        />
      )}
    </article>
  );
});

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

function App() {
  const [selection, setSelection] = useState(boot.data.selection),
    [cross, setCross] = useState(boot.data.cross),
    [days, setDays] = useState(boot.data.days);
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
        throw Object.assign(new Error(error.message), {
          loginUrl: error.loginUrl,
        });
      }
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "Dashboard access is unavailable."
            : "Could not update the dashboard. Retry refresh.",
        );
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error("Please sign in again to update the dashboard.");
      return response.json();
    },
  });
  const data = query.data || boot.data;
  useEffect(() => {
    if (query.error?.loginUrl) closeFilters();
  }, [query.error, closeFilters]);
  // Preserve panel objects as filters change so chart instances stay mounted.
  const panels = boot.data.panels;
  const sections = useMemo(() => sectionsOf(panels), [panels]);
  const activeFilters =
    data.variables.filter((variable) => {
      const value = selection[variable.name] || [variable.default];
      return (
        JSON.stringify(value) !== JSON.stringify(asArray(variable.default))
      );
    }).length + Object.keys(cross).length;
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
  useEffect(() => {
    history.replaceState(null, "", "?" + filterParams(selection, cross, days));
  }, [selection, cross, days]);
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
    };
    document.documentElement.dataset.viewerReady = "true";
    performance.mark("olx-viewer-render");
  }, [data, query.isFetching, query.isPlaceholderData, selection, cross]);
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
  return (
    <>
      <header>
        <a className="brand" href="/olx/dashboard/olx-overview/">
          <span className="brand-mark" aria-hidden="true" />
          OLX Market Watch
        </a>
        <nav>
          {boards.map((board) => (
            <a
              key={board.uid}
              className={board.uid === data.uid ? "active" : ""}
              href={`/olx/dashboard/${encodeURIComponent(board.uid)}/`}
            >
              {board.title.replace("OLX.ba ", "").replace("OLX ", "")}
            </a>
          ))}
        </nav>
      </header>
      <main>
        <div className="heading">
          <div>
            <h1>{data.title.replace("OLX.ba ", "").replace("OLX ", "")}</h1>
            <p className="eyebrow">
              Observed OLX.ba asking prices. Exits are not confirmed sales.
            </p>
          </div>
          <div className="freshness">
            <span role="status" className={query.isFetching ? "busy" : ""}>
              {query.isFetching
                ? "Updating…"
                : "Updated " +
                  new Date(data.asOf).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
            </span>
            <div className="segmented" role="group" aria-label="Time window">
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
              Filters{activeFilters ? ` (${activeFilters})` : ""}
            </button>
            <button
              onClick={refresh}
              disabled={query.isFetching}
              aria-label="Refresh"
              title="Refresh data"
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
              aria-label="Close filter panel"
              onClick={closeFilters}
            />
          )}
          <aside
            id="dashboard-filters"
            className="filter-panel"
            aria-label="Dashboard filters"
            hidden={!filtersOpen}
          >
            <div className="filter-panel-heading">
              <h2>Filters</h2>
              <button aria-label="Collapse filters" onClick={closeFilters}>
                ×
              </button>
            </div>
            <input
              className="filter-search"
              aria-label="Find a filter"
              placeholder="Find a filter…"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
            />
            <div className="filters">
              {data.variables
                .filter((variable) =>
                  variable.label
                    .toLowerCase()
                    .includes(filterSearch.toLowerCase()),
                )
                .map((variable) => (
                  <label key={variable.name}>
                    {variable.label}
                    {variable.type === "number" ? (
                      <AreaInput
                        label={variable.label}
                        min={variable.min ?? 0}
                        value={
                          selection[variable.name]?.[0] ?? variable.default
                        }
                        onCommit={(value) =>
                          setSelection((s) => ({
                            ...s,
                            [variable.name]: [value],
                          }))
                        }
                      />
                    ) : (
                      <select
                        aria-label={variable.label}
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
                          setSelection((s) => ({
                            ...s,
                            [variable.name]:
                              values.length > 1
                                ? values.filter((value) => value !== "All")
                                : values.length
                                  ? values
                                  : ["All"],
                          }));
                        }}
                      >
                        <option value="All">All</option>
                        {(data.options[variable.name] || variable.choices)
                          .filter((v) => v !== "All")
                          .map((value) => (
                            <option key={String(value)} value={String(value)}>
                              {String(value)}
                            </option>
                          ))}
                      </select>
                    )}
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
                Reset filters
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
                    {label(dimension)}: {values.join(", ")}{" "}
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
                    <a href={query.error.loginUrl}>Sign in</a>
                  </>
                )}
              </p>
            )}
            <div className={query.isFetching ? "sections busy" : "sections"}>
              {sections.map((section) => (
                <section
                  className="dash-section"
                  key={section.name + section.panels[0].id}
                  aria-label={section.name || undefined}
                >
                  {section.name && <h2>{section.name}</h2>}
                  <div className="grid">
                    {section.panels.map((panel) => (
                      <Panel
                        key={panel.id}
                        panel={panel}
                        rows={data.rows[panel.key] || EMPTY}
                        selected={
                          panel.type === "bar"
                            ? cross[panel.category]
                            : undefined
                        }
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      </main>
      <footer>
        Data collected from OLX.ba listings. Prices are asking prices in KM; an
        exit means a listing left the site, not that it sold.
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
