import { NextResponse } from "next/server";

import { placeName, searchPlaces } from "@/lib/routing";
import { plannerAccess, routeErrorResponse } from "@/lib/routing/access";

/**
 * Finding a place by name (`?q=`), or naming a pin dropped on the map (`?lat=&lng=`), for the
 * route planner. `?trip=` names the trip being planned, whose business is checked and counted.
 * OpenStreetMap's search; see src/lib/routing/index.ts.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const access = await plannerAccess(url.searchParams.get("trip"));
  if ("response" in access) return access.response;

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (url.searchParams.has("lat") && url.searchParams.has("lng")) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    return NextResponse.json({ label: await placeName(access.farmId, { lat, lng }) });
  }

  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < 3) return NextResponse.json({ places: [] });
  try {
    return NextResponse.json({ places: await searchPlaces(access.farmId, q) });
  } catch (failure) {
    return routeErrorResponse(failure);
  }
}
