import * as echarts from "echarts/core";
import {
  BarChart,
  BoxplotChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { compact, duration, label, plain } from "./format";
import { locale, t, valueLabel } from "./i18n";
echarts.use([
  BarChart,
  BoxplotChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);
export { echarts };

export const FILTER_DIMENSIONS = new Set([
  "rooms",
  "neighborhood",
  "floor",
  "seller_type",
  "segment",
  "deal",
  "search_key",
  "status",
]);

// Validated against the #121a24 panel surface (dataviz palette, dark steps).
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const STATUS = { ok: "#0ca30c", error: "#d03b3b", running: "#6b7785" };
const INK = {
  secondary: "#b4c0cc",
  muted: "#7d8a98",
  grid: "#212c39",
  axis: "#2f3b49",
};
const SURFACE = "#121a24";
// Sequential blue on the dark surface: low values dark, high values light,
// matching the map pins.
const RAMP = ["#184f95", "#2a78d6", "#6da7ec", "#b7d3f6"];
const OTHER = "#6b7785";
// A pie past this many slices folds its smallest ones into "Other".
const PIE_SLICES = 6;

const signed = (panel) => /change/.test(panel.field || "");

export function number(value, panel = {}) {
  if (panel.type === "big_number" && /^(seconds|minutes)$/.test(panel.suffix))
    return duration(value, panel.suffix);
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const text = Number(value).toLocaleString(locale(), {
    maximumFractionDigits: panel.decimals ?? 0,
    minimumFractionDigits: panel.decimals ?? 0,
  });
  return signed(panel) && Number(value) > 0 ? "+" + text : text;
}
export function unit(panel) {
  return panel.suffix === "seconds" || panel.suffix === "minutes"
    ? "ago"
    : panel.suffix || "";
}
const withUnit = (value, panel) =>
  (signed(panel) && value > 0 ? "+" : "") +
  plain(value, panel.decimals) +
  (panel.suffix && panel.suffix !== "%" ? " " : "") +
  (panel.suffix || "");

const axisLabel = { color: INK.muted, fontSize: 11 };
const valueAxis = (extra = {}) => ({
  type: "value",
  axisLabel: { ...axisLabel, formatter: (v) => compact(v) },
  splitLine: { lineStyle: { color: INK.grid } },
  axisLine: { show: false },
  axisTick: { show: false },
  nameTextStyle: { color: INK.muted, fontSize: 11, align: "left" },
  ...extra,
});
const tooltipBase = {
  confine: true,
  renderMode: "richText",
  backgroundColor: "#0b1118",
  borderColor: "#2f3b49",
  padding: [8, 10],
  textStyle: { color: "#e6edf3", fontSize: 12 },
};

// Ordered buckets read left to right; nominal categories rank top to bottom.
export const isOrdinal = (panel) =>
  /_(bracket|band)$/.test(panel.category || "");

export function chartHeight(panel, rows) {
  if ((panel.type === "bar" || panel.type === "box") && !isOrdinal(panel))
    return Math.max(220, rows.length * 30 + 40);
  if (panel.type === "heatmap")
    return Math.max(220, distinct(rows, panel.y).length * 28 + 72);
  return panel.type === "scatter" ? 340 : 280;
}

const distinct = (rows, column) => [
  ...new Set(rows.map((row) => String(row[column] ?? "unknown"))),
];

function colorFor(name, index) {
  return STATUS[name] || SERIES[index % SERIES.length];
}

export function chartOption(panel, rows, selected) {
  const columns = Object.keys(rows[0] || {});
  const base = {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: INK.secondary, fontFamily: "inherit" },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
  };
  if (panel.type === "scatter") return scatterOption(panel, rows, base);
  if (panel.type === "bar") return barOption(panel, rows, base, selected);
  if (panel.type === "pie") return pieOption(panel, rows, base, selected);
  if (panel.type === "box") return boxOption(panel, rows, base, selected);
  if (panel.type === "heatmap") return heatmapOption(panel, rows, base);
  return timeOption(panel, rows, columns, base);
}

function scatterOption(panel, rows, base) {
  const { x, y } = panel;
  const percent = /pct/.test(y);
  return {
    ...base,
    grid: { ...base.grid, top: 28, bottom: 28 },
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (params) => {
        const row = rows[params.dataIndex] || {};
        return `${row.title || ""}\n${label(x)}: ${plain(row[x])}\n${label(y)}: ${plain(row[y])}${row.neighborhood ? "\n" + row.neighborhood : ""}`;
      },
    },
    xAxis: valueAxis({
      name: label(x),
      nameLocation: "middle",
      nameGap: 26,
      scale: true,
      splitLine: { show: false },
      axisLine: { show: true, lineStyle: { color: INK.axis } },
    }),
    yAxis: valueAxis({ name: label(y), scale: !percent }),
    series: [
      {
        type: "scatter",
        symbolSize: 8,
        itemStyle: {
          color: SERIES[0],
          opacity: 0.75,
          borderColor: SURFACE,
          borderWidth: 1,
        },
        emphasis: { scale: 1.6, itemStyle: { opacity: 1 } },
        data: rows.map((row) => [row[x], row[y]]),
        markLine: percent
          ? {
              silent: true,
              symbol: "none",
              label: { show: false },
              lineStyle: { color: INK.axis, type: "solid", width: 1 },
              data: [{ yAxis: 0 }],
            }
          : undefined,
      },
    ],
  };
}

// Numeric columns besides the plotted ones go into the tooltip.
const extrasOf = (rows, plotted) =>
  Object.keys(rows[0] || {}).filter(
    (key) => !plotted.includes(key) && typeof rows[0][key] === "number",
  );
const extraLines = (row, extras) =>
  extras.map((key) => `${label(key)}: ${plain(row[key])}`);
const namesOf = (rows, dimension) =>
  rows.map((row) => String(row[dimension] ?? "unknown"));
const activeSet = (selected) =>
  selected?.length ? new Set(selected.map(String)) : null;

function categoryAxisFor(names, vertical) {
  return {
    type: "category",
    data: names,
    axisLabel: vertical
      ? { ...axisLabel, interval: 0, hideOverlap: true, formatter: valueLabel }
      : {
          ...axisLabel,
          formatter: valueLabel,
          color: INK.secondary,
          width: 120,
          overflow: "truncate",
          interval: 0,
        },
    axisLine: { lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  };
}

function barOption(panel, rows, base, selected) {
  const { category: dimension, value: measure } = panel;
  const vertical = isOrdinal(panel);
  const names = namesOf(rows, dimension);
  const extras = extrasOf(rows, [dimension, measure]);
  const categoryAxis = categoryAxisFor(names, vertical);
  const active = activeSet(selected);
  return {
    ...base,
    grid: { ...base.grid, right: vertical ? 16 : 56, top: vertical ? 24 : 4 },
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (params) => {
        const row = rows[params.dataIndex] || {};
        return [
          valueLabel(names[params.dataIndex]),
          `${label(measure)}: ${withUnit(row[measure], panel)}`,
          ...extraLines(row, extras),
        ].join("\n");
      },
    },
    xAxis: vertical ? categoryAxis : valueAxis({ splitNumber: 4 }),
    yAxis: vertical
      ? valueAxis({ splitNumber: 4 })
      : { ...categoryAxis, inverse: true },
    series: [
      {
        type: "bar",
        name: label(measure),
        barMaxWidth: 24,
        barCategoryGap: "30%",
        cursor: FILTER_DIMENSIONS.has(dimension) ? "pointer" : "default",
        itemStyle: { borderRadius: vertical ? [4, 4, 0, 0] : [0, 4, 4, 0] },
        data: rows.map((row, index) => ({
          value: row[measure],
          itemStyle: {
            color: SERIES[0],
            opacity: active && !active.has(names[index]) ? 0.3 : 1,
          },
        })),
        label: {
          show: true,
          position: vertical ? "top" : "right",
          color: INK.secondary,
          fontSize: 11,
          formatter: (p) => number(p.value, panel),
        },
      },
    ],
  };
}

// Part-to-whole for a few categories. Slices keep the query's row order so a
// category keeps its color when filters change the mix.
function pieOption(panel, rows, base, selected) {
  const { category: dimension, value: measure } = panel;
  const names = namesOf(rows, dimension);
  let slices = rows.map((row, index) => ({
    index,
    name: names[index],
    value: Number(row[measure]) || 0,
  }));
  let other = 0;
  if (slices.length > PIE_SLICES) {
    const kept = new Set(
      [...slices].sort((a, b) => b.value - a.value).slice(0, PIE_SLICES - 1),
    );
    other = slices
      .filter((slice) => !kept.has(slice))
      .reduce((sum, slice) => sum + slice.value, 0);
    slices = slices.filter((slice) => kept.has(slice));
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, other);
  const share = (value) => plain(total ? (100 * value) / total : 0, 0) + "%";
  const extras = extrasOf(rows, [dimension, measure]);
  const active = activeSet(selected);
  const data = slices.map((slice, n) => ({
    ...slice,
    name: valueLabel(slice.name),
    itemStyle: {
      color: SERIES[n],
      opacity: active && !active.has(slice.name) ? 0.3 : 1,
    },
  }));
  // Index -1 has no row, so clicking "Other" selects nothing.
  if (other)
    data.push({
      index: -1,
      name: t("Other"),
      value: other,
      itemStyle: { color: OTHER },
    });
  return {
    ...base,
    legend: {
      top: 0,
      left: 0,
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: INK.secondary, fontSize: 12 },
    },
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (params) => {
        const row = rows[params.data.index];
        return [
          params.name,
          `${label(measure)}: ${withUnit(params.value, panel)} · ${share(params.value)}`,
          ...(row ? extraLines(row, extras) : []),
        ].join("\n");
      },
    },
    series: [
      {
        type: "pie",
        radius: ["42%", "66%"],
        center: ["50%", "56%"],
        cursor: FILTER_DIMENSIONS.has(dimension) ? "pointer" : "default",
        itemStyle: { borderColor: SURFACE, borderWidth: 2 },
        label: {
          color: INK.secondary,
          fontSize: 11,
          formatter: (params) => `${params.name} · ${share(params.value)}`,
        },
        labelLine: { lineStyle: { color: INK.axis } },
        emphasis: { scaleSize: 4 },
        data,
      },
    ],
  };
}

// Median dot inside the middle half (box); whiskers reach the 10th and 90th
// percentiles when the query returns p10 and p90.
function boxOption(panel, rows, base, selected) {
  const { category: dimension, value: measure } = panel;
  const vertical = isOrdinal(panel);
  const names = namesOf(rows, dimension);
  const spread = ["p10", "p25", "p75", "p90"];
  const extras = extrasOf(rows, [dimension, measure, ...spread]);
  const active = activeSet(selected);
  const low = (row) => row.p10 ?? row.p25;
  const high = (row) => row.p90 ?? row.p75;
  const at = (index, value) =>
    vertical ? [names[index], value] : [value, names[index]];
  const categoryAxis = categoryAxisFor(names, vertical);
  const range = (a, b) => `${plain(a)} – ${plain(b)}`;
  return {
    ...base,
    grid: { ...base.grid, right: vertical ? 16 : 56, top: vertical ? 24 : 4 },
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (params) => {
        const row = rows[params.dataIndex] || {};
        return [
          valueLabel(names[params.dataIndex]),
          `${label(measure)}: ${withUnit(row[measure], panel)}`,
          `${t("Middle half")}: ${range(row.p25, row.p75)}`,
          ...(row.p10 != null && row.p90 != null
            ? [`${t("10th–90th percentile")}: ${range(row.p10, row.p90)}`]
            : []),
          ...extraLines(row, extras),
        ].join("\n");
      },
    },
    xAxis: vertical ? categoryAxis : valueAxis({ splitNumber: 4, scale: true }),
    yAxis: vertical
      ? valueAxis({ splitNumber: 4, scale: true })
      : { ...categoryAxis, inverse: true },
    series: [
      {
        type: "boxplot",
        boxWidth: [6, 14],
        cursor: FILTER_DIMENSIONS.has(dimension) ? "pointer" : "default",
        data: rows.map((row, index) => ({
          value: [low(row), row.p25, row[measure], row.p75, high(row)],
          itemStyle: {
            color: "rgba(57, 135, 229, 0.22)",
            borderColor: SERIES[0],
            borderWidth: 1.5,
            opacity: active && !active.has(names[index]) ? 0.3 : 1,
          },
        })),
      },
      {
        type: "scatter",
        symbolSize: 8,
        itemStyle: { color: SERIES[0], borderColor: SURFACE, borderWidth: 2 },
        data: rows.map((row, index) => at(index, row[measure])),
      },
      // The median's figure sits past the whisker so it never covers the box.
      {
        type: "scatter",
        silent: true,
        symbolSize: 0,
        label: {
          show: true,
          position: vertical ? "top" : "right",
          color: INK.secondary,
          fontSize: 11,
          formatter: (params) =>
            number(rows[params.dataIndex]?.[measure], panel),
        },
        data: rows.map((row, index) => at(index, high(row))),
      },
    ],
  };
}

// Two dimensions at once; the cell's shade carries the value.
function heatmapOption(panel, rows, base) {
  const { x, y, value: measure } = panel;
  // Columns sort naturally (rooms 0, 1, 2 … 5+); rows keep the query order.
  const xs = distinct(rows, x).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const ys = distinct(rows, y);
  const cells = rows
    .map((row, index) => ({ row, index, value: Number(row[measure]) }))
    .filter((cell) => cell.row[measure] != null && Number.isFinite(cell.value));
  const values = cells.map((cell) => cell.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  // Light cells take dark ink so every figure stays legible.
  const light = (value) => max > min && (value - min) / (max - min) > 0.55;
  const extras = extrasOf(rows, [x, y, measure]);
  return {
    ...base,
    grid: { ...base.grid, top: 8, bottom: 40 },
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (params) => {
        const row = rows[params.data.index] || {};
        return [
          `${valueLabel(String(row[y] ?? "unknown"))} · ${valueLabel(String(row[x] ?? "unknown"))}`,
          `${label(measure)}: ${withUnit(row[measure], panel)}`,
          ...extraLines(row, extras),
        ].join("\n");
      },
    },
    xAxis: {
      ...categoryAxisFor(xs, true),
      name: label(x),
      nameLocation: "middle",
      nameGap: 24,
      nameTextStyle: { color: INK.muted, fontSize: 11 },
      splitArea: { show: false },
    },
    yAxis: { ...categoryAxisFor(ys, false), inverse: true },
    visualMap: {
      type: "continuous",
      min,
      max,
      calculable: false,
      orient: "horizontal",
      right: 0,
      bottom: 0,
      itemWidth: 10,
      itemHeight: 120,
      text: [compact(max), compact(min)],
      textStyle: { color: INK.muted, fontSize: 11 },
      inRange: { color: RAMP },
    },
    series: [
      {
        type: "heatmap",
        cursor: FILTER_DIMENSIONS.has(y) ? "pointer" : "default",
        itemStyle: { borderColor: SURFACE, borderWidth: 2, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: "#e6edf3", borderWidth: 1 } },
        label: { show: true, fontSize: 11 },
        data: cells.map((cell) => ({
          index: cell.index,
          value: [
            xs.indexOf(String(cell.row[x] ?? "unknown")),
            ys.indexOf(String(cell.row[y] ?? "unknown")),
            cell.value,
          ],
          label: {
            color: light(cell.value) ? "#0b1118" : "#e6edf3",
            formatter: () => number(cell.value, panel),
          },
        })),
      },
    ],
  };
}

function timeOption(panel, rows, columns, base) {
  const time =
    columns.find((key) => /^(time|day|date)$/.test(key)) || columns[0];
  const measures = columns.filter(
    (key) => key !== time && rows.some((row) => typeof row[key] === "number"),
  );
  const band = measures.includes("p25") && measures.includes("p75");
  const plotted = band ? measures.filter((m) => m === "median") : measures;
  const at = (row) => Date.parse(row[time]);
  const hourly = rows.some((row) => new Date(at(row)).getHours() !== 0);
  const formatTooltip = (params) => {
    const row = rows[params[0]?.dataIndex];
    if (!row) return "";
    const day = new Date(at(row)).toLocaleString(locale(), {
      day: "numeric",
      month: "short",
      ...(hourly
        ? { hour: "2-digit", minute: "2-digit" }
        : { year: "numeric" }),
    });
    return [
      day,
      ...measures.map(
        (m) =>
          `${label(m)}: ${["listings"].includes(m) ? plain(row[m]) : withUnit(row[m], panel)}`,
      ),
    ].join("\n");
  };
  const series = plotted.map((measure, index) => ({
    name: label(measure),
    type: panel.bars ? "bar" : "line",
    stack:
      panel.bars && measures.every((m) => STATUS[m]) ? "status" : undefined,
    showSymbol: false,
    symbolSize: 8,
    barMaxWidth: 16,
    lineStyle: { width: 2 },
    itemStyle: {
      color: colorFor(measure, index),
      borderRadius: panel.bars ? [2, 2, 0, 0] : 0,
    },
    areaStyle:
      !panel.bars && plotted.length === 1 && !band
        ? { color: colorFor(measure, index), opacity: 0.1 }
        : undefined,
    z: 3,
    data: rows.map((row) => [at(row), row[measure]]),
  }));
  if (band)
    series.unshift(
      {
        name: "p25",
        type: "line",
        stack: "band",
        silent: true,
        symbol: "none",
        lineStyle: { opacity: 0 },
        data: rows.map((row) => [at(row), row.p25]),
      },
      {
        name: t("Interquartile range"),
        type: "line",
        stack: "band",
        silent: true,
        symbol: "none",
        lineStyle: { opacity: 0 },
        areaStyle: { color: SERIES[0], opacity: 0.16 },
        itemStyle: { color: SERIES[0] },
        data: rows.map((row) => [
          at(row),
          row.p75 == null || row.p25 == null ? null : row.p75 - row.p25,
        ]),
      },
    );
  const legend = band || plotted.length > 1;
  return {
    ...base,
    grid: { ...base.grid, top: legend ? 36 : 16 },
    legend: legend
      ? {
          top: 0,
          left: 0,
          icon: "roundRect",
          itemWidth: 12,
          itemHeight: 4,
          textStyle: { color: INK.secondary, fontSize: 12 },
          data: band
            ? [label("median"), t("Interquartile range")]
            : plotted.map(label),
        }
      : { show: false },
    tooltip: {
      ...tooltipBase,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: INK.axis } },
      formatter: formatTooltip,
    },
    xAxis: {
      type: "time",
      axisLabel: { ...axisLabel, hideOverlap: true },
      axisLine: { lineStyle: { color: INK.axis } },
      axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: valueAxis({ scale: band }),
    series,
  };
}

// Category charts select by their category; heatmap cells by their row.
const SELECTS = {
  bar: "category",
  pie: "category",
  box: "category",
  heatmap: "y",
};
export const selectsBy = (panel) => panel[SELECTS[panel.type]];

// Pie and heatmap data carry their row index; other series align with rows.
export function selectionFor(panel, rows, event) {
  const row = rows[event.data?.index ?? event.dataIndex];
  const dimension = selectsBy(panel);
  if (row && FILTER_DIMENSIONS.has(dimension))
    return { dimension, value: row[dimension] };
  return null;
}
