/**
 * Handing a planned route to a navigation app on the driver's phone. FLEETWISE plans and
 * checks the route; turn-by-turn directions stay with the apps drivers already use. Both are
 * plain links (Google Maps URLs and Waze deep links), with no key and no cost.
 */

export type Stop = { lat: number; lng: number; label?: string };

const at = (p: Stop) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/**
 * Google Maps directions through every stop, in order. Google picks its own road between two
 * stops, so a route chosen for a particular road is steered by a stop on that road.
 */
export function googleMapsLink(stops: Stop[]): string | null {
  if (stops.length < 2) return null;
  const params = new URLSearchParams({
    api: "1",
    origin: at(stops[0]),
    destination: at(stops[stops.length - 1]),
    travelmode: "driving",
  });
  const between = stops.slice(1, -1);
  if (between.length > 0) params.set("waypoints", between.map(at).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Waze takes one destination: the next place the driver has to be. */
export function wazeLink(stop: Stop | null | undefined): string | null {
  if (!stop) return null;
  return `https://waze.com/ul?ll=${encodeURIComponent(at(stop))}&navigate=yes`;
}
