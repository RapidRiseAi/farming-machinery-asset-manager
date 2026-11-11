import { NextResponse } from "next/server";

import { planRoutes, validPoints } from "@/lib/routing";
import { plannerAccess, routeErrorResponse } from "@/lib/routing/access";

/** Room for the most stops a route may have and a trip id, with plenty to spare. */
const MAX_BODY = 16 * 1024;

/**
 * Routes through the planner's points, in order, for the planner to draw and choose from.
 * Nothing is saved here: the chosen route is asked for again when it is saved, so what a trip
 * keeps always came from the route service and not from the browser. The body's trip_id names
 * the trip being planned, whose business is checked and counted.
 */
export async function POST(request: Request) {
  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "invalid" }, { status: 413 });
  let body: { points?: unknown; trip_id?: unknown } | null = null;
  try {
    body = JSON.parse(raw) as { points?: unknown; trip_id?: unknown } | null;
  } catch {
    body = null;
  }

  const access = await plannerAccess(body?.trip_id);
  if ("response" in access) return access.response;

  const points = validPoints(body?.points);
  if (!points) return NextResponse.json({ error: "invalid" }, { status: 400 });

  try {
    const { provider, options } = await planRoutes(access.farmId, points);
    return NextResponse.json({
      provider,
      options: options.map((o) => ({ distance_m: o.distanceM, duration_s: o.durationS, line: o.line })),
    });
  } catch (failure) {
    return routeErrorResponse(failure);
  }
}
