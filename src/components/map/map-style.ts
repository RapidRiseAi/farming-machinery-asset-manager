/**
 * What every map in FLEETWISE shares: the tiles, where to look with nothing to show, and the
 * brand's colours read from the theme.
 *
 * Tiles come from OpenFreeMap for now, which needs no key or server and has no uptime promise.
 * That is fine while the map is in testing; move to self-hosted tiles before release.
 */
export const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** South Africa, for when there is nothing to fit the map to yet. */
export const HOME: [number, number] = [25.5, -29];

/**
 * MapLibre, loaded only when a map is opened, with its worker named. Since version 6 it ships
 * as ES modules with named exports only (there is no default export), and its worker is a file
 * of its own that a bundler cannot find from the library's guess. Written as `new URL(...,
 * import.meta.url)`, webpack copies the worker into /_next/static with a hashed name, so it
 * loads from this site: the policy's worker-src 'self' covers it. Called before the first map;
 * the worker pool starts with that map.
 */
export async function loadMapLibre(): Promise<typeof import("maplibre-gl")> {
  const lib = await import("maplibre-gl");
  if (!lib.getWorkerUrl()) lib.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());
  return lib;
}

export type ThemeToken = "brand-ink" | "accent-ink" | "sand-400" | "status-overdue";

/**
 * A theme colour as the map library wants it. The theme keeps colours as three numbers
 * ("1 69 36") so Tailwind can add opacity, which is not a colour on its own: reading them as
 * one gave every marker `currentColor` until 11 November.
 */
export function themeColour(token: ThemeToken, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  return parts.length === 3 ? `rgb(${parts.join(", ")})` : fallback;
}
