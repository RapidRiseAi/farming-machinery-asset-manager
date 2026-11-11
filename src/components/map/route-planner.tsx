"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";

import { buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { boundsOf } from "@/lib/map-data";
import { HOME, MAP_STYLE, themeColour } from "./map-style";

/**
 * Planning a trip's route the way a navigation app does: find a place or drop a pin, add stops
 * between, drag a pin to move it, and choose one of the routes offered. Routes come from the
 * server (/api/routing/routes), which holds the route service's key; nothing is saved until
 * the manager presses save, and the server then asks for the routes again and keeps the one
 * chosen.
 *
 * Map text is built from text nodes: a place name came from a person's typing or a search.
 */

type Point = { key: string; lat: number | null; lng: number | null; label: string; auto: boolean };
type Option = { distance_m: number; duration_s: number; line: [number, number][] };
type Place = { label: string; lat: number; lng: number };

export type PlannerLabels = {
  start: string;
  stop: string;
  end: string;
  searchPlaceholder: string;
  search: string;
  finding: string;
  noResults: string;
  otherMatches: string;
  pin: string;
  pinning: string;
  addStop: string;
  remove: string;
  up: string;
  down: string;
  routes: string;
  routeOption: string;
  onlyOne: string;
  loading: string;
  needEnds: string;
  save: string;
  cancel: string;
  pinned: string;
  dragHint: string;
  hoursMinutes: string;
  minutes: string;
  attribution: string;
  errors: Record<string, string>;
};

export type PlannerStop = { lat: number; lng: number; label: string };

let counter = 0;
const newKey = () => `p${(counter += 1)}`;
const placed = (p: Point): p is Point & { lat: number; lng: number } => p.lat != null && p.lng != null;
const letter = (i: number) => String.fromCharCode(65 + (i % 26));

// Fills on the map are the brand's literal colours: the tiles are light in both themes, so a
// theme-following green (light in dark mode) would wash out under white letters.
const GREEN = "#00572C";
const GOLD = "#936505";

export function RoutePlanner({
  tripId,
  initialStops,
  origin,
  destination,
  savedDistanceM,
  labels,
  numberLocale,
  saveAction,
  cancelHref,
}: {
  tripId: string;
  initialStops: PlannerStop[];
  origin: string;
  destination: string;
  /** The saved route's length, to choose the same route again when the routes come back. */
  savedDistanceM: number | null;
  labels: PlannerLabels;
  numberLocale: string;
  saveAction: (formData: FormData) => void | Promise<void>;
  cancelHref: string;
}) {
  const [points, setPoints] = useState<Point[]>(() =>
    initialStops.length >= 2
      ? initialStops.map((s) => ({ key: newKey(), lat: s.lat, lng: s.lng, label: s.label, auto: false }))
      : [
          { key: newKey(), lat: null, lng: null, label: origin, auto: false },
          { key: newKey(), lat: null, lng: null, label: destination, auto: false },
        ],
  );
  const [active, setActive] = useState<string | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [chosen, setChosen] = useState(0);
  const matchSaved = useRef(savedDistanceM);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // What the last search for each point found besides the place it put on the map.
  const [found, setFound] = useState<Record<string, { others: Place[]; none?: boolean; error?: string }>>({});
  const [searching, setSearching] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const pointsRef = useRef(points);
  const activeRef = useRef(active);
  pointsRef.current = points;
  activeRef.current = active;
  const holder = useRef<HTMLDivElement>(null);

  const ends = points.length >= 2 && placed(points[0]) && placed(points[points.length - 1]);
  const route = useMemo(() => (ends ? points.filter(placed).map((p) => ({ lat: p.lat, lng: p.lng })) : []), [points, ends]);
  const routeKey = JSON.stringify(route);

  const roleOf = (i: number) => (i === 0 ? labels.start : i === points.length - 1 ? labels.end : labels.stop.replace("{n}", String(i)));

  // == Naming a pin ============================================================
  const nameIt = async (key: string, lat: number, lng: number) => {
    const response = await fetch(`/api/routing/search?lat=${lat}&lng=${lng}`).catch(() => null);
    const json = response?.ok ? ((await response.json().catch(() => null)) as { label?: string | null } | null) : null;
    const label = json?.label;
    if (!label) return;
    setPoints((list) => list.map((p) => (p.key === key && p.auto ? { ...p, label } : p)));
  };

  const place = (key: string, lat: number, lng: number) => {
    setPoints((list) => list.map((p) => (p.key === key ? { ...p, lat, lng, label: labels.pinned, auto: true } : p)));
    void nameIt(key, lat, lng);
  };

  // == The map, once ===========================================================
  useEffect(() => {
    let cancelled = false;
    void import("maplibre-gl").then((lib) => {
      if (cancelled || !holder.current) return;
      libRef.current = lib.default;
      const map = new lib.default.Map({ container: holder.current, style: MAP_STYLE, center: HOME, zoom: 4.5 });
      map.addControl(new lib.default.NavigationControl({ showCompass: false }));
      mapRef.current = map;

      map.on("click", (e) => {
        // A tap on a route chooses it; that is handled by the line layers.
        if (map.getLayer("routes-alt") && map.queryRenderedFeatures(e.point, { layers: ["routes-alt"] }).length > 0) return;
        const list = pointsRef.current;
        const key = activeRef.current ?? list.find((p) => !placed(p))?.key ?? null;
        if (!key) return;
        place(key, e.lngLat.lat, e.lngLat.lng);
        const after = list.findIndex((p) => p.key === key);
        const next = list.find((p, i) => i > after && !placed(p));
        setActive(next?.key ?? null);
      });

      map.on("load", () => {
        map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "routes-alt",
          type: "line",
          source: "routes",
          filter: ["==", ["get", "chosen"], false],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": themeColour("sand-400", "#716e64"), "line-width": 6, "line-opacity": 0.75 },
        });
        map.addLayer({
          id: "routes-chosen",
          type: "line",
          source: "routes",
          filter: ["==", ["get", "chosen"], true],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": GREEN, "line-width": 7 },
        });
        map.on("click", "routes-alt", (e) => {
          const idx = Number(e.features?.[0]?.properties?.idx);
          if (Number.isFinite(idx)) setChosen(idx);
        });
        map.on("mouseenter", "routes-alt", () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", "routes-alt", () => (map.getCanvas().style.cursor = ""));
        setReady(true);
      });
    });
    return () => {
      cancelled = true;
      markers.current.forEach((m) => m.remove());
      markers.current.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is made once; handlers read the latest points through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // == Pins follow the points ==================================================
  useEffect(() => {
    const lib = libRef.current;
    const map = mapRef.current;
    if (!lib || !map || !ready) return;
    const seen = new Set<string>();
    points.forEach((p, i) => {
      if (!placed(p)) return;
      seen.add(p.key);
      let marker = markers.current.get(p.key);
      if (!marker) {
        const el = document.createElement("div");
        el.className =
          "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-sm font-bold text-white shadow-md";
        el.style.background = GREEN;
        const created = new lib.Marker({ element: el, draggable: true }).setLngLat([p.lng, p.lat]).addTo(map);
        const key = p.key;
        created.on("dragend", () => {
          const at = created.getLngLat();
          place(key, at.lat, at.lng);
        });
        markers.current.set(key, created);
        marker = created;
      }
      marker.setLngLat([p.lng, p.lat]);
      const el = marker.getElement();
      el.textContent = letter(i);
      el.setAttribute("aria-label", `${roleOf(i)}: ${p.label}`);
      el.style.background = i === 0 || i === points.length - 1 ? GREEN : GOLD;
    });
    for (const [key, marker] of markers.current) {
      if (!seen.has(key)) {
        marker.remove();
        markers.current.delete(key);
      }
    }
    // roleOf reads labels and the count, both covered by points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, ready]);

  // == Routes for the points, shortly after they stop changing =================
  useEffect(() => {
    if (route.length < 2) {
      setOptions([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      setProblem(null);
      const response = await fetch("/api/routing/routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trip_id: tripId, points: route }),
        signal: controller.signal,
      }).catch(() => null);
      if (controller.signal.aborted) return;
      const json = (await response?.json().catch(() => null)) as { options?: Option[]; error?: string } | null;
      if (!response?.ok || !json?.options) {
        setOptions([]);
        setStatus("error");
        setProblem(labels.errors[json?.error ?? "unavailable"] ?? labels.errors.unavailable);
        return;
      }
      const list = json.options;
      setOptions(list);
      // Reopening a saved plan: choose the route it saved, not simply the first one offered.
      const saved = matchSaved.current;
      matchSaved.current = null;
      if (saved != null) {
        let best = 0;
        list.forEach((o, idx) => {
          if (Math.abs(o.distance_m - saved) < Math.abs(list[best].distance_m - saved)) best = idx;
        });
        setChosen(best);
      } else {
        setChosen((c) => (c < list.length ? c : 0));
      }
      setStatus("idle");
    }, 450);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // routeKey stands for route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, tripId]);

  // == Lines on the map, and the view fitted to them ===========================
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource("routes") as GeoJSONSource | undefined;
    source?.setData({
      type: "FeatureCollection",
      features: options.map((o, idx) => ({
        type: "Feature",
        properties: { idx, chosen: idx === chosen },
        geometry: { type: "LineString", coordinates: o.line },
      })),
    });
  }, [options, chosen, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const shown = [
      ...points.filter(placed).map((p) => ({ lat: p.lat, lng: p.lng })),
      ...(options[0]?.line ?? []).map(([lng, lat]) => ({ lat, lng })),
    ];
    const box = boundsOf(shown);
    if (box && shown.length > 1) map.fitBounds(box, { padding: 60, maxZoom: 13, duration: 300 });
    else if (shown.length === 1) map.easeTo({ center: [shown[0].lng, shown[0].lat], zoom: 11, duration: 300 });
    // Fitted when a new set of routes arrives, not on every choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, ready]);

  // == The list ================================================================
  const put = (key: string, p: Place) =>
    setPoints((list) => list.map((x) => (x.key === key ? { ...x, lat: p.lat, lng: p.lng, label: p.label, auto: false } : x)));

  const forget = (key: string) =>
    setFound((f) => {
      if (!(key in f)) return f;
      const rest = { ...f };
      delete rest[key];
      return rest;
    });

  // As in a navigation app, a search puts its best match on the map at once. A typed name that
  // was never put on the map looked set but gave no route; the other matches stay listed below.
  const search = async (key: string) => {
    const query = pointsRef.current.find((p) => p.key === key)?.label.trim() ?? "";
    if (query.length < 3) return;
    setSearching(key);
    const response = await fetch(`/api/routing/search?q=${encodeURIComponent(query)}`).catch(() => null);
    const json = (await response?.json().catch(() => null)) as { places?: Place[]; error?: string } | null;
    setSearching((s) => (s === key ? null : s));
    if (!response?.ok) {
      setFound((f) => ({ ...f, [key]: { others: [], error: labels.errors[json?.error ?? "unavailable"] ?? labels.errors.unavailable } }));
      return;
    }
    const places = json?.places ?? [];
    if (places[0]) put(key, places[0]);
    setFound((f) => ({ ...f, [key]: { others: places.slice(1), none: places.length === 0 } }));
  };

  const choosePlace = (key: string, p: Place) => {
    put(key, p);
    forget(key);
    setActive(null);
  };

  // Opened from a trip that names its places but has no pins yet: look the names up, as if
  // Search had been pressed, one after the other (the place search takes one request a second).
  const lookedUp = useRef(false);
  useEffect(() => {
    if (lookedUp.current) return;
    lookedUp.current = true;
    void (async () => {
      for (const p of pointsRef.current) {
        if (!placed(p) && p.label.trim().length >= 3) await search(p.key);
      }
    })();
    // Once, on opening; search reads the latest points through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (i: number, by: -1 | 1) =>
    setPoints((list) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const addStop = () => {
    const key = newKey();
    setPoints((list) => [...list.slice(0, -1), { key, lat: null, lng: null, label: "", auto: false }, list[list.length - 1]]);
    setActive(key);
  };

  const remove = (key: string) => setPoints((list) => (list.length > 2 ? list.filter((p) => p.key !== key) : list));

  const km = (m: number) => `${new Intl.NumberFormat(numberLocale, { maximumFractionDigits: m < 10_000 ? 1 : 0 }).format(m / 1000)} km`;
  const time = (s: number) => {
    const h = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return h > 0 ? labels.hoursMinutes.replace("{h}", String(h)).replace("{m}", String(min)) : labels.minutes.replace("{m}", String(min));
  };

  const savedStops = points.filter(placed).map((p) => ({ lat: p.lat, lng: p.lng, label: p.label.trim() }));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(320px,400px)_1fr]">
      <div className="order-2 flex flex-col gap-3 lg:order-1">
        <ol className="flex flex-col gap-2">
          {points.map((p, i) => (
            <li key={p.key} className={`rounded-xl border p-2 ${active === p.key ? "border-brand-ink bg-brand-tint" : "border-sand-200"}`}>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${i === 0 || i === points.length - 1 ? "bg-brand-600" : "bg-gold-600"}`}
                >
                  {letter(i)}
                </span>
                <label className="sr-only" htmlFor={`rp_${p.key}`}>{roleOf(i)}</label>
                <input
                  id={`rp_${p.key}`}
                  value={p.label}
                  placeholder={`${roleOf(i)}: ${labels.searchPlaceholder}`}
                  maxLength={160}
                  onChange={(e) => {
                    const label = e.target.value;
                    setPoints((list) => list.map((x) => (x.key === p.key ? { ...x, label, auto: false } : x)));
                    forget(p.key);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void search(p.key);
                    }
                  }}
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-sand-300 bg-surface px-3 text-sm text-ink"
                />
                <button
                  type="button"
                  onClick={() => void search(p.key)}
                  className={buttonVariants({ variant: "secondary", size: "sm" })}
                  disabled={searching === p.key}
                >
                  {labels.search}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-9 text-sm">
                <button
                  type="button"
                  aria-pressed={active === p.key}
                  onClick={() => setActive(active === p.key ? null : p.key)}
                  className="min-h-9 rounded-lg px-2 font-medium text-brand-ink underline"
                >
                  {active === p.key ? labels.pinning : labels.pin}
                </button>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="min-h-9 rounded-lg px-2 text-sand-700 disabled:opacity-40" aria-label={`${labels.up}: ${roleOf(i)}`}>↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === points.length - 1} className="min-h-9 rounded-lg px-2 text-sand-700 disabled:opacity-40" aria-label={`${labels.down}: ${roleOf(i)}`}>↓</button>
                {points.length > 2 ? (
                  <button type="button" onClick={() => remove(p.key)} className="min-h-9 rounded-lg px-2 text-status-due underline">{labels.remove}</button>
                ) : null}
              </div>
              {searching === p.key ? <p className="mt-2 pl-9 text-sm text-sand-600">{labels.finding}</p> : null}
              {found[p.key]?.error ? <p role="alert" className="mt-2 pl-9 text-sm text-status-due">{found[p.key].error}</p> : null}
              {found[p.key]?.none ? <p role="status" className="mt-2 pl-9 text-sm text-sand-600">{labels.noResults}</p> : null}
              {found[p.key]?.others.length ? (
                <div className="mt-2">
                  <p className="pl-1 text-xs text-sand-600">{labels.otherMatches}</p>
                  <ul className="mt-1 flex flex-col divide-y divide-sand-100 rounded-lg border border-sand-200">
                    {found[p.key].others.map((place, n) => (
                      <li key={n}>
                        <button type="button" onClick={() => choosePlace(p.key, place)} className="w-full p-2 text-left text-sm text-ink hover:bg-sand-50">
                          {place.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {points.length < 25 ? (
          <button type="button" onClick={addStop} className={buttonVariants({ variant: "secondary" })}>{labels.addStop}</button>
        ) : null}

        <div>
          <h3 className="text-sm font-semibold text-sand-900">{labels.routes}</h3>
          <p role="status" className="text-sm text-sand-600">
            {status === "loading" ? labels.loading : status === "error" ? problem : !ends ? labels.needEnds : null}
          </p>
          {options.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-2">
              {options.map((o, idx) => (
                <li key={idx}>
                  <button
                    type="button"
                    aria-pressed={idx === chosen}
                    onClick={() => setChosen(idx)}
                    className={`w-full rounded-xl border p-3 text-left ${idx === chosen ? "border-brand-ink bg-brand-tint" : "border-sand-200"}`}
                  >
                    <span className="block font-semibold text-ink">{labels.routeOption.replace("{n}", String(idx + 1))}</span>
                    <span className="block text-sm text-sand-700">{km(o.distance_m)} · {time(o.duration_s)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {options.length === 1 ? <p className="mt-2 text-sm text-sand-600">{labels.onlyOne}</p> : null}
          {problem && status !== "error" ? <p className="mt-2 text-sm text-status-due">{problem}</p> : null}
        </div>

        <form action={saveAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="trip_id" value={tripId} />
          <input type="hidden" name="waypoints" value={JSON.stringify(savedStops)} />
          <input type="hidden" name="choice" value={String(chosen)} />
          <SubmitButton variant="primary" disabled={options.length === 0 || status === "loading"}>{labels.save}</SubmitButton>
          <a href={cancelHref} className="text-sm font-medium underline">{labels.cancel}</a>
        </form>
      </div>

      <div className="order-1 flex flex-col gap-1 lg:order-2">
        <div ref={holder} className="h-[50vh] min-h-[320px] w-full overflow-hidden rounded-xl border border-sand-200 lg:h-[70vh]" />
        <p className="text-xs text-sand-600">{active ? labels.pinning : labels.dragHint}</p>
        <p className="text-xs text-sand-500">{labels.attribution}</p>
      </div>
    </div>
  );
}
