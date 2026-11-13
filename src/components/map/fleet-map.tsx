"use client";

import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

import { boundsOf } from "@/lib/map-data";
import { HOME, MAP_STYLE, loadMapLibre, themeColour } from "./map-style";

/**
 * The map itself. MapLibre is large, so it loads only here, and only for people who open this
 * page. Everything put on the map came from a person's typing at some point, so popups are
 * built from text nodes, never from HTML.
 *
 * Two kinds of line: the route a trip was planned to take (dashed, gold) and the route it was
 * driven (solid, brand green). `route` is the driven one, kept for the pages that predate plans.
 */
export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  detail: string;
  kind: "vehicle" | "fault" | "stop";
};

export type MapLine = { id: string; kind: "planned" | "driven"; coords: [number, number][] };

function popupNode(marker: MapMarker): HTMLElement {
  const box = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = marker.title;
  const detail = document.createElement("div");
  detail.textContent = marker.detail;
  box.append(title, detail);
  return box;
}

function colourOf(kind: MapMarker["kind"]): string {
  if (kind === "fault") return themeColour("status-overdue", "#b3201f");
  if (kind === "stop") return "#936505";
  // The brand's literal green: the tiles are light in both themes.
  return "#00572C";
}

// One empty list for every render, so a page that passes no lines does not redraw the map.
const NO_ROUTE: [number, number][] = [];
const NO_LINES: MapLine[] = [];

export function FleetMap({
  markers,
  route = NO_ROUTE,
  lines = NO_LINES,
  size = "page",
}: {
  markers: MapMarker[];
  route?: [number, number][];
  lines?: MapLine[];
  /** "card" for a map inside a card on another page. */
  size?: "page" | "card";
}) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;
    const all: MapLine[] = [...lines, ...(route.length > 1 ? [{ id: "route", kind: "driven" as const, coords: route }] : [])];

    void loadMapLibre().then((maplibre) => {
      if (cancelled || !holder.current) return;
      const map = new maplibre.Map({ container: holder.current, style: MAP_STYLE, center: HOME, zoom: 4.5 });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }));
      cleanup = () => map.remove();

      for (const m of markers) {
        new maplibre.Marker({ color: colourOf(m.kind) })
          .setLngLat([m.lng, m.lat])
          .setPopup(new maplibre.Popup({ offset: 24 }).setDOMContent(popupNode(m)))
          .addTo(map);
      }

      map.on("load", () => {
        for (const line of all.filter((l) => l.coords.length > 1)) {
          map.addSource(`line-${line.id}`, {
            type: "geojson",
            data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.coords } },
          });
          map.addLayer({
            id: `line-${line.id}`,
            type: "line",
            source: `line-${line.id}`,
            layout: { "line-cap": "round", "line-join": "round" },
            paint:
              line.kind === "planned"
                ? { "line-color": "#936505", "line-width": 4, "line-dasharray": [2, 1.5] }
                : { "line-color": "#00572C", "line-width": 4 },
          });
        }
        const box = boundsOf([...markers, ...all.flatMap((l) => l.coords.map(([lng, lat]) => ({ lat, lng })))]);
        if (box) map.fitBounds(box, { padding: 60, maxZoom: 14, duration: 0 });
      });
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [markers, route, lines]);

  return (
    <div
      ref={holder}
      className={`${size === "card" ? "h-[40vh] min-h-[260px]" : "h-[60vh] min-h-[320px]"} w-full overflow-hidden rounded-xl border border-sand-200`}
    />
  );
}
