import {
  Map,
  Popup,
  LngLatBounds,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { openAd } from "./links";
setWorkerUrl(workerUrl);

export function createMap(container) {
  const map = new Map({
    container,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [18.41, 43.86],
    zoom: 11,
    attributionControl: true,
    cooperativeGestures: true,
  });
  map.addControl(new NavigationControl(), "top-right");
  const popup = new Popup({ closeButton: false, closeOnClick: false });
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
    for (const name of [
      "price",
      "ppm2",
      "closing_price",
      "closing_ppm2",
      "sqm",
      "rooms",
      "neighborhood",
      "days_listed",
      "last_seen",
    ]) {
      if (feature.properties[name] != null) {
        const line = document.createElement("div");
        line.textContent = `${name}: ${feature.properties[name]}`;
        content.append(line);
      }
    }
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

export function updatePins(map, rows, fit) {
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
        "circle-radius": 5,
        "circle-color": "#36d7ba",
        "circle-stroke-width": 1,
        "circle-stroke-color": "#102e31",
      },
    });
  }
  if (fit && features.length) {
    const bounds = new LngLatBounds();
    features.forEach((feature) => bounds.extend(feature.geometry.coordinates));
    map.fitBounds(bounds, { padding: 35, maxZoom: 14, duration: 0 });
  }
}
