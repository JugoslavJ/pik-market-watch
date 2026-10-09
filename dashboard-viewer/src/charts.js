import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { compact, duration, label, plain } from "./format";
import { locale, t, valueLabel } from "./i18n";
echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
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
  if (panel.type === "bar" && !isOrdinal(panel))
    return Math.max(220, rows.length * 30 + 40);
  return panel.type === "scatter" ? 340 : 280;
}

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

function barOption(panel, rows, base, selected) {
  const { category: dimension, value: measure } = panel;
  const vertical = isOrdinal(panel);
  const names = rows.map((row) => String(row[dimension] ?? "unknown"));
  const name = (value) => valueLabel(value, dimension);
  const extras = Object.keys(rows[0] || {}).filter(
    (key) =>
      key !== dimension && key !== measure && typeof rows[0][key] === "number",
  );
  const categoryAxis = {
    type: "category",
    data: names,
    axisLabel: vertical
      ? { ...axisLabel, interval: 0, hideOverlap: true, formatter: name }
      : {
          ...axisLabel,
          formatter: name,
          color: INK.secondary,
          width: 120,
          overflow: "truncate",
          interval: 0,
        },
    axisLine: { lineStyle: { color: INK.axis } },
    axisTick: { show: false },
  };
  const active = selected?.length ? new Set(selected.map(String)) : null;
  return {
    ...base,
    grid: { ...base.grid, right: vertical ? 16 : 56, top: vertical ? 24 : 4 },
    tooltip: {
      ...tooltipBase,
      trigger: "item",
      formatter: (params) => {
        const row = rows[params.dataIndex] || {};
        return [
          name(names[params.dataIndex]),
          `${label(measure)}: ${withUnit(row[measure], panel)}`,
          ...extras.map((key) => `${label(key)}: ${plain(row[key])}`),
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

export function selectionFor(panel, rows, index) {
  const row = rows[index];
  if (!row) return null;
  if (panel.type === "bar") {
    const dimension = panel.category;
    if (FILTER_DIMENSIONS.has(dimension))
      return { dimension, value: row[dimension] };
  }
  return null;
}
