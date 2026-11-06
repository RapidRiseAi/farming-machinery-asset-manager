import { NextResponse } from "next/server";

import { currentFarmId, effectiveFarmRole, getProfile, farmIsUsable } from "@/lib/auth";
import { featureOn } from "@/lib/features";
import { isUuid } from "@/lib/ids";
import { cleanPoints } from "@/lib/map-data";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * A phone's route, in batches. Only for a trip that is still running, and only by the driver
 * on it or a manager of that business: the session decides the vehicle and the business, so
 * nothing a phone sends can put a point on somebody else's vehicle.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return NextResponse.json({ error: "auth" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { session_id?: unknown; points?: unknown } | null;
  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  if (!isUuid(sessionId)) return NextResponse.json({ error: "bad-request" }, { status: 400 });

  const svc = createServiceClient();
  const { data: session, error } = await svc
    .from("driving_sessions")
    .select("id, farm_id, machine_id, driver_id, ended_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (!session || session.ended_at) return NextResponse.json({ error: "not-running" }, { status: 409 });

  const farmId = session.farm_id as string;
  const role = await effectiveFarmRole(farmId, profile);
  const allowed = session.driver_id === profile.id || role === "owner" || role === "manager";
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!(await farmIsUsable(farmId, profile))) return NextResponse.json({ error: "stopped" }, { status: 402 });

  // A feature in testing answers only for the business it is on for.
  const current = await currentFarmId(profile);
  if (!(await featureOn("map", current === farmId ? current : farmId))) {
    return NextResponse.json({ error: "off" }, { status: 404 });
  }

  const points = cleanPoints(body?.points);
  if (points.length === 0) return NextResponse.json({ ok: true, saved: 0 });

  const { error: insertError } = await svc.from("asset_positions").insert(
    points.map((p) => ({
      farm_id: farmId,
      machine_id: session.machine_id,
      session_id: sessionId,
      recorded_at: p.at,
      lat: p.lat,
      lng: p.lng,
      speed_kmh: p.speed,
      accuracy_m: p.accuracy,
      source: "phone",
    })),
  );
  if (insertError) {
    captureError(insertError, { where: "positions:insert" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, saved: points.length });
}
