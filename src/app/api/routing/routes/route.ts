import { NextResponse } from "next/server";

import { planRoutes, validPoints } from "@/lib/routing";
import { plannerAccess, routeErrorResponse } from "@/lib/routing/access";

/**
 * Routes through the planner's points, in order, for the planner to draw and choose from.
 * Nothing is saved here: the chosen route is asked for again when it is saved, so what a trip
 * keeps always came from the route service and not from the browser.
 */
export async function POST(request: Request) {
  const access = await plannerAccess();
  if ("response" in access) return access.response;

  const body = (await request.json().catch(() => null)) as { points?: unknown } | null;
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
