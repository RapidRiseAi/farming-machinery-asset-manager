import "server-only";

import { NextResponse } from "next/server";

import { currentFarmId, effectiveFarmRole, farmIsUsable, getProfile } from "@/lib/auth";
import { featureOn } from "@/lib/features";
import { RouteError } from "./providers";

/**
 * Who may ask for routes and places: an owner or manager of a business that is paid up and
 * has the map. These calls cost money past the free allowance, so they are refused before
 * anything is sent anywhere.
 */
export async function plannerAccess(): Promise<{ farmId: string } | { response: NextResponse }> {
  const profile = await getProfile();
  if (!profile || !profile.active) return { response: NextResponse.json({ error: "auth" }, { status: 401 }) };
  const farmId = await currentFarmId(profile);
  if (!farmId) return { response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "manager") return { response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  if (!(await farmIsUsable(farmId, profile))) return { response: NextResponse.json({ error: "stopped" }, { status: 402 }) };
  if (!(await featureOn("map", farmId))) return { response: NextResponse.json({ error: "off" }, { status: 404 }) };
  return { farmId };
}

/** A route service's refusal, as an answer the planner can explain. */
export function routeErrorResponse(failure: unknown): NextResponse {
  if (failure instanceof RouteError) {
    const status = failure.code === "not_configured" ? 503 : failure.code === "limit" ? 429 : failure.code === "unavailable" ? 502 : 422;
    return NextResponse.json({ error: failure.code }, { status });
  }
  return NextResponse.json({ error: "unavailable" }, { status: 502 });
}
