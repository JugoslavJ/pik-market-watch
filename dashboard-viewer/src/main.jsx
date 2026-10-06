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
import { chartOption, echarts, number, selectionFor, unit } from "./charts";
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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return visible;
}

const Plot = memo(function Plot({ panel, rows, onSelect }) {
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
      else if (panel.type === "xychart" && rows[event.dataIndex]?.url)
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
      instance.current.setOption(chartOption(panel, rows), {
        notMerge: true,
        lazyUpdate: false,
      });
      ref.current.dataset.ready = "true";
    }
  }, [panel, rows, visible]);
  return <div className="plot" ref={ref} aria-label={panel.title} />;
});

const ListingTable = memo(function ListingTable({ rows, onSelect }) {
  const ref = useRef(null),
    visible = useVisible(ref);
  const [sort, setSort] = useState(null),
    [page, setPage] = useState(0),
    [search, setSearch] = useState("");
  const columns = Object.keys(rows[0] || {}).filter((name) => name !== "url");
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
    link.download = "listings.csv";
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
                    <th key={column}>
                      <button
                        onClick={() =>
                          setSort({
                            column,
                            direction:
                              sort?.column === column ? -sort.direction : 1,
                          })
                        }
                      >
                        {column.replaceAll("_", " ")}{" "}
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
                {filtered.slice(page * 25, page * 25 + 25).map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column}>
                        {column === "title" && validAd(row.url) ? (
                          <a href={row.url} target="_blank" rel="noreferrer">
                            {row[column]}
                          </a>
                        ) : [
                            "rooms",
                            "neighborhood",
                            "floor",
                            "seller_type",
                            "segment",
                            "category",
                            "status",
                            "search_key",
                            "deal",
                            "article_id",
                          ].includes(column) ? (
                          <button
                            className="cell-filter"
                            onClick={() => onSelect(column, row[column])}
                          >
                            {String(row[column] ?? "unknown")}
                          </button>
                        ) : typeof row[column] === "number" ? (
                          row[column].toLocaleString("en-GB", {
                            maximumFractionDigits: 2,
                          })
                        ) : (
                          String(row[column] ?? "—")
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>
              Page {page + 1} / {Math.max(1, Math.ceil(filtered.length / 25))}
            </span>
            <button
              disabled={(page + 1) * 25 >= filtered.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
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
  latest.current = rows;
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
          updatePins(map, latest.current, true);
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
      mapRef.current.updatePins(mapRef.current.map, rows, false);
  }, [rows]);
  return (
    <div className="map" ref={ref} aria-label={panel.title}>
      {failed && <p>Map unavailable. Listing links are in the table below.</p>}
    </div>
  );
});

const Panel = memo(function Panel({ panel, rows, onSelect }) {
  return (
    <section
      className={"panel " + (panel.type === "stat" ? "stat" : "")}
      data-panel={panel.id}
      style={{ gridColumn: `span ${panel.grid.w}` }}
    >
      <h2>{panel.title}</h2>
      {panel.type === "stat" ? (
        <>
          <div className="value">{number(rows[0]?.[panel.metric], panel)}</div>
          <div className="unit">{unit(panel)}</div>
        </>
      ) : panel.type === "table" ? (
        <ListingTable rows={rows} onSelect={onSelect} />
      ) : panel.type === "geomap" ? (
        <Pins panel={panel} rows={rows} />
      ) : (
        <Plot panel={panel} rows={rows} onSelect={onSelect} />
      )}
    </section>
  );
});

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
      const params = new URLSearchParams({
        s: JSON.stringify(selection),
        c: JSON.stringify(cross),
        days: String(days),
      });
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
  const activeFilters =
    data.variables.filter((variable) => {
      const value = selection[variable.name] || [variable.default];
      return (
        JSON.stringify(value) !==
        JSON.stringify(
          Array.isArray(variable.default)
            ? variable.default
            : [variable.default],
        )
      );
    }).length +
    Object.keys(cross).length +
    (days !== (data.uid === "olx-health" ? 2 : 90) ? 1 : 0);
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
    const params = new URLSearchParams({
      s: JSON.stringify(selection),
      c: JSON.stringify(cross),
      days: String(days),
    });
    history.replaceState(null, "", "?" + params);
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
          OLX Market Watch
        </a>
        <nav>
          {boot.boards.map((board) => (
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
            <p className="eyebrow">MARKET INTELLIGENCE</p>
            <h1>{data.title}</h1>
          </div>
          <div className="freshness">
            <span role="status">
              {query.isFetching
                ? "Updating…"
                : "As of " +
                  new Date(data.asOf).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
            </span>
            <button
              ref={filtersButton}
              aria-expanded={filtersOpen}
              aria-controls="dashboard-filters"
              onClick={() => setFiltersOpen((open) => !open)}
            >
              Filters{activeFilters ? ` (${activeFilters})` : ""}
            </button>
            <button onClick={refresh} disabled={query.isFetching}>
              Refresh
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
                    {variable.type === "textbox" ? (
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
              <label>
                Time window
                <select
                  aria-label="Time window"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  {[2, 7, 30, 90, 180, 365].map((value) => (
                    <option key={value} value={value}>
                      Last {value} days
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => {
                  setCross({});
                  setDays(boot.data.uid === "olx-health" ? 2 : 90);
                  setSelection(
                    Object.fromEntries(
                      data.variables.map((v) => [
                        v.name,
                        Array.isArray(v.default) ? v.default : [v.default],
                      ]),
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
                    {dimension}: {values.join(", ")} ×
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
            <div className="grid">
              {panels.map((panel) => (
                <Panel
                  key={panel.id}
                  panel={panel}
                  rows={data.rows[panel.key] || EMPTY}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        </div>
      </main>
      <footer>
        Observed asking prices and listing exits. Exits are not confirmed sales.
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
