import "server-only";

import { NextResponse } from "next/server";

import { currentFarmId, effectiveFarmRole, farmIsUsable, getProfile } from "@/lib/auth";
import { featureOn } from "@/lib/features";
import { isUuid } from "@/lib/ids";
import { captureError } from "@/lib/observability";
import { createClient } from "@/lib/supabase/server";
import { RouteError } from "./providers";

const deny = (error: string, status: number) => ({ response: NextResponse.json({ error }, { status }) });

/**
 * Who may ask for routes and places: an owner or manager of a business that is paid up and
 * has the map. These calls cost money past the free allowance, so they are refused before
 * anything is sent anywhere.
 *
 * The business is the trip's own when the planner names its trip. Someone who runs two
 * businesses plans a trip of either, whichever site they last chose, and its searches and
 * routes are counted against that trip's business. Without a trip, the current site.
 */
export async function plannerAccess(tripId?: unknown): Promise<{ farmId: string } | { response: NextResponse }> {
  const profile = await getProfile();
  if (!profile || !profile.active) return deny("auth", 401);

  let farmId: string | null;
  if (tripId != null && tripId !== "") {
    if (typeof tripId !== "string" || !isUuid(tripId)) return deny("invalid", 400);
    // Read as the person: a trip they cannot see is not theirs to plan.
    const supabase = await createClient();
    const { data, error } = await supabase.from("trips").select("farm_id").eq("id", tripId).is("deleted_at", null).maybeSingle();
    if (error) {
      captureError(error, { where: "routing:access-trip" });
      return deny("unavailable", 502);
    }
    if (!data) return deny("forbidden", 403);
    farmId = data.farm_id as string;
  } else {
    farmId = await currentFarmId(profile);
  }
  if (!farmId) return deny("forbidden", 403);

  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "manager") return deny("forbidden", 403);
  if (!(await farmIsUsable(farmId, profile))) return deny("stopped", 402);
  if (!(await featureOn("map", farmId))) return deny("off", 404);
  return { farmId };
}

/** A route service's refusal, as an answer the planner can explain. */
export function routeErrorResponse(failure: unknown): NextResponse {
  if (failure instanceof RouteError) {
    const status =
      failure.code === "not_configured"
        ? 503
        : failure.code === "limit" || failure.code === "busy"
          ? 429
          : failure.code === "unavailable"
            ? 502
            : 422;
    return NextResponse.json({ error: failure.code }, { status });
  }
  return NextResponse.json({ error: "unavailable" }, { status: 502 });
}
