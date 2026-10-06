import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
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
  "category",
  "search_key",
  "status",
]);

export function number(value, panel = {}) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-GB", {
    maximumFractionDigits: panel.decimals ?? 0,
    minimumFractionDigits: panel.decimals ?? 0,
  });
}
export function unit(panel) {
  return panel.suffix || "";
}

export function chartOption(panel, rows) {
  const columns = Object.keys(rows[0] || {});
  const base = {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: "#a9b9c9", fontFamily: "system-ui" },
    grid: { left: 65, right: 22, top: 24, bottom: 55 },
    tooltip: { trigger: "axis", confine: true, renderMode: "richText" },
    legend: { bottom: 0, textStyle: { color: "#a9b9c9" }, type: "scroll" },
    color: ["#36d7ba", "#79a8ff", "#ffbb63", "#e680a8", "#aa94ef"],
  };
  if (panel.type === "scatter") {
    const { x, y } = panel;
    return {
      ...base,
      tooltip: {
        trigger: "item",
        renderMode: "richText",
        formatter: (params) =>
          `${rows[params.dataIndex]?.title || ""}\n${x}: ${params.value[0]}\n${y}: ${params.value[1]}`,
      },
      xAxis: { type: "value", name: x, nameLocation: "middle", nameGap: 30 },
      yAxis: { type: "value", name: y },
      series: [
        {
          type: "scatter",
          symbolSize: 6,
          data: rows.map((row) => [row[x], row[y]]),
        },
      ],
    };
  }
  if (panel.type === "bar") {
    const { category: dimension, value: measure } = panel;
    return {
      ...base,
      legend: { show: false },
      grid: { left: 135, right: 55, top: 14, bottom: 35 },
      xAxis: { type: "value", name: unit(panel) },
      yAxis: {
        type: "category",
        inverse: true,
        data: rows.map((row) => String(row[dimension] ?? "unknown")),
        axisLabel: { width: 125, overflow: "truncate", interval: 0 },
      },
      series: [
        {
          type: "bar",
          name: measure,
          data: rows.map((row) => row[measure]),
          label: {
            show: true,
            position: "right",
            color: "#cbd8e4",
            formatter: (p) => number(p.value, panel),
          },
        },
      ],
    };
  }
  const time =
    columns.find((key) => /^(time|day|date)$/.test(key)) || columns[0];
  const measures = columns.filter(
    (key) => key !== time && rows.some((row) => typeof row[key] === "number"),
  );
  return {
    ...base,
    xAxis: { type: "time", axisLabel: { hideOverlap: true } },
    yAxis: {
      type: "value",
      name: unit(panel),
      splitLine: { lineStyle: { color: "#253344" } },
    },
    series: measures.map((measure) => ({
      name: measure,
      type: panel.bars ? "bar" : "line",
      showSymbol: false,
      data: rows.map((row) => [Date.parse(row[time]), row[measure]]),
    })),
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
