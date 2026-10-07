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

export function createMap(container) {
  const map = new Map({
    container,
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
