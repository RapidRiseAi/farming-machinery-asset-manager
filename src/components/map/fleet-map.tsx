"use client";

import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";

import { boundsOf } from "@/lib/map-data";

/**
 * The map itself. MapLibre is large, so it loads only here, and only for people who open this
 * page. Everything put on the map came from a person's typing at some point, so popups are
 * built from text nodes, never from HTML.
 *
 * Tiles come from OpenFreeMap for now, which needs no key or server and has no uptime promise.
 * That is fine while this is in testing; move to self-hosted tiles before release.
 */
const STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** South Africa, for when there is nothing to fit the map to yet. */
const HOME: [number, number] = [25.5, -29];

export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  detail: string;
  kind: "vehicle" | "fault" | "stop";
};

function popupNode(marker: MapMarker): HTMLElement {
  const box = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = marker.title;
  const detail = document.createElement("div");
  detail.textContent = marker.detail;
  box.append(title, detail);
  return box;
}

/** Read from the theme, so a marker matches the brand and follows it. */
function colourOf(kind: MapMarker["kind"]): string {
  const styles = getComputedStyle(document.documentElement);
  const token = kind === "fault" ? "--color-status-overdue" : kind === "stop" ? "--color-gold-500" : "--color-brand-700";
  return styles.getPropertyValue(token).trim() || "currentColor";
}

export function FleetMap({ markers, route }: { markers: MapMarker[]; route: [number, number][] }) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cleanup = () => {};
    let cancelled = false;

    void import("maplibre-gl").then(({ default: maplibre }) => {
      if (cancelled || !holder.current) return;
      const map = new maplibre.Map({ container: holder.current, style: STYLE, center: HOME, zoom: 4.5 });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }));
      cleanup = () => map.remove();

      for (const m of markers) {
        new maplibre.Marker({ color: colourOf(m.kind) })
          .setLngLat([m.lng, m.lat])
          .setPopup(new maplibre.Popup({ offset: 24 }).setDOMContent(popupNode(m)))
          .addTo(map);
      }

      map.on("load", () => {
        if (route.length > 1) {
          map.addSource("route", {
            type: "geojson",
            data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } },
          });
          map.addLayer({
            id: "route",
            type: "line",
            source: "route",
            paint: { "line-color": colourOf("vehicle"), "line-width": 4 },
          });
        }
        const box = boundsOf([...markers, ...route.map(([lng, lat]) => ({ lat, lng }))]);
        if (box) map.fitBounds(box, { padding: 60, maxZoom: 14, duration: 0 });
      });
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [markers, route]);

  return <div ref={holder} className="h-[60vh] min-h-[320px] w-full overflow-hidden rounded-xl border border-sand-200" />;
}
