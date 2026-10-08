import {
  Map,
  Popup,
  LngLatBounds,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { cell, label, PIN_COLORS, PIN_MISSING } from "./format";
import { valueLabel } from "./i18n";
import { openAd } from "./links";
setWorkerUrl(workerUrl);

const POPUP_FIELDS = [
  "price",
  "ppm2",
  "closing_price",
  "closing_ppm2",
  "sqm",
  "rooms",
  "location",
  "neighborhood",
  "days_listed",
  "last_seen",
];

// Reports keep the drawn canvas so the browser can print it.
export function createMap(container, { print = false } = {}) {
  const map = new Map({
    container,
    canvasContextAttributes: { preserveDrawingBuffer: print },
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [18.41, 43.86],
    zoom: 11,
    attributionControl: true,
    cooperativeGestures: true,
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  const popup = new Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 10,
    maxWidth: "280px",
  });
  map.on("mouseenter", "listings", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "listings", () => {
    map.getCanvas().style.cursor = "";
    popup.remove();
  });
  map.on("mousemove", "listings", (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = feature.properties.title || "OLX listing";
    content.append(title);
    const list = document.createElement("dl");
    for (const name of POPUP_FIELDS) {
      const value = feature.properties[name];
      if (value == null || value === "null") continue;
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label(name);
      detail.textContent = cell(
        typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)
          ? Number(value)
          : value,
      );
      list.append(term, detail);
    }
    content.append(list);
    popup
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(content)
      .addTo(map);
  });
  map.on("click", "listings", (event) => {
    openAd(event.features?.[0]?.properties?.url);
  });
  return map;
}

function circleColor(scale) {
  if (!scale) return PIN_COLORS[2];
  const value = ["to-number", ["get", scale.field], 0];
  const steps = scale.breaks.flatMap((limit, index) => [
    limit,
    scale.colors[index + 1],
  ]);
  // Rentals and listings without a KM/m² stay neutral rather than "cheap".
  return [
    "case",
    [">", value, 0],
    ["step", value, scale.colors[0], ...steps],
    PIN_MISSING,
  ];
}

export function updatePins(map, rows, fit, scale) {
  const features = rows
    .filter(
      (row) =>
        Number.isFinite(Number(row.latitude)) &&
        Number.isFinite(Number(row.longitude)) &&
        row.latitude != null &&
        row.longitude != null,
    )
    .map((row) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [Number(row.longitude), Number(row.latitude)],
      },
      properties: row,
    }));
  const data = { type: "FeatureCollection", features };
  if (map.getSource("listings")) map.getSource("listings").setData(data);
  else {
    map.addSource("listings", { type: "geojson", data });
    map.addLayer({
      id: "listings",
      type: "circle",
      source: "listings",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 7],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#0b1118",
        "circle-opacity": 0.9,
      },
    });
  }
  map.setPaintProperty("listings", "circle-color", circleColor(scale));
  if (fit && features.length) {
    const bounds = new LngLatBounds();
    features.forEach((feature) => bounds.extend(feature.geometry.coordinates));
    map.fitBounds(bounds, { padding: 35, maxZoom: 14, duration: 0 });
  }
}

let outlines;
// Neighborhood outlines are static; one request serves every area map.
export function loadAreas() {
  outlines ||= fetch("/olx/api/areas").then((response) => {
    if (!response.ok) throw new Error("Areas unavailable");
    return response.json();
  });
  outlines.catch(() => {
    outlines = null;
  });
  return outlines;
}

function areaColor(scale) {
  if (!scale) return PIN_MISSING;
  const value = ["to-number", ["get", scale.field], 0];
  const steps = scale.breaks.flatMap((limit, index) => [
    limit,
    scale.colors[index + 1],
  ]);
  return [
    "case",
    [">", value, 0],
    ["step", value, scale.colors[0], ...steps],
    PIN_MISSING,
  ];
}

// Joins panel rows to outlines by neighborhood; clicks select that area.
export function updateAreas(map, shapes, rows, scale, fit, onSelect) {
  const byName = new globalThis.Map(
    rows.map((row) => [String(row.neighborhood), row]),
  );
  const data = {
    type: "FeatureCollection",
    features: shapes.features.map((feature) => ({
      ...feature,
      properties: {
        ...(byName.get(feature.properties.name) || {}),
        neighborhood: feature.properties.name,
      },
    })),
  };
  if (map.getSource("areas")) map.getSource("areas").setData(data);
  else {
    map.addSource("areas", { type: "geojson", data });
    map.addLayer({
      id: "areas",
      type: "fill",
      source: "areas",
      paint: { "fill-opacity": 0.72 },
    });
    map.addLayer({
      id: "area-lines",
      type: "line",
      source: "areas",
      paint: { "line-color": "#0b1118", "line-width": 1 },
    });
    const popup = new Popup({ closeButton: false, closeOnClick: false });
    map.on("mousemove", "areas", (event) => {
      const properties = event.features?.[0]?.properties;
      if (!properties) return;
      map.getCanvas().style.cursor = "pointer";
      const content = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = valueLabel(properties.neighborhood);
      const list = document.createElement("dl");
      for (const [name, value] of Object.entries(properties)) {
        if (name === "neighborhood" || value == null || value === "null")
          continue;
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label(name);
        detail.textContent = cell(
          /^-?d+(.d+)?$/.test(String(value)) ? Number(value) : value,
        );
        list.append(term, detail);
      }
      content.append(title, list);
      popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
    });
    map.on("mouseleave", "areas", () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });
    map.on("click", "areas", (event) => {
      const name = event.features?.[0]?.properties?.neighborhood;
      if (name) map.__onAreaSelect?.(name);
    });
  }
  map.__onAreaSelect = onSelect;
  map.setPaintProperty("areas", "fill-color", areaColor(scale));
  if (fit) {
    const bounds = new LngLatBounds();
    // Frame the areas that have data; rural outlines would shrink the city.
    const priced = data.features.filter((feature) =>
      byName.has(feature.properties.neighborhood),
    );
    for (const feature of priced.length ? priced : data.features)
      for (const ring of feature.geometry.type === "Polygon"
        ? feature.geometry.coordinates
        : feature.geometry.coordinates.flat())
        ring.forEach((point) => bounds.extend(point));
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 20, duration: 0 });
  }
}
