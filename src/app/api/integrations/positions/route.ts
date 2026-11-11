import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { cleanPoints } from "@/lib/map-data";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Positions from a vehicle tracker, for a phone's screen cannot stay on all day. The same
 * connection and token as /api/integrations/driving (Driver activity, tracker connections):
 *
 *   POST /api/integrations/positions
 *   Authorization: Bearer <the connection's token>
 *   { "machine_id": "<the tracker's own id for the vehicle>",
 *     "points": [{ "at": "2026-11-11T08:00:00+02:00", "lat": -25.7, "lng": 28.2, "speed": 80 }] }
 *
 * Up to 500 points a request, up to seven days old (a backlog after a dead zone). Kept only
 * while the map is on for the business; the answer says how many were kept. docs/ROUTING.md.
 */
const MAX_BYTES = 128 * 1024;

const bodySchema = z.object({
  machine_id: z.string().trim().min(1).max(200),
  points: z.array(z.unknown()).min(1).max(500),
});

export async function POST(request: Request) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = createServiceClient();
  const secret = await db
    .from("driver_connection_secrets")
    .select("connection_id")
    .eq("token_hash", createHash("sha256").update(match[1]).digest("hex"))
    .maybeSingle();
  if (secret.error) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (!secret.data) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Count what arrives, chunked bodies included, before parsing any of it.
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "invalid_event" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed: ReturnType<typeof bodySchema.safeParse>;
  try {
    parsed = bodySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "invalid_event" }, { status: 400 });

  const points = cleanPoints(parsed.data.points, new Date(), { maxAgeHours: 7 * 24, max: 500 });
  if (points.length === 0) return NextResponse.json({ ok: true, kept: 0 });

  const { data, error } = await db.rpc("ingest_tracker_positions", {
    p_connection: secret.data.connection_id,
    p_machine_external: parsed.data.machine_id,
    p_points: points.map((p) => ({ at: p.at, lat: p.lat, lng: p.lng, speed: p.speed })),
  });
  if (error) {
    const status = error.code === "22023" ? 409 : error.code === "42501" ? 403 : 503;
    const code = error.code === "22023" ? "event_rejected" : error.code === "42501" ? "forbidden" : "unavailable";
    return NextResponse.json({ error: code }, { status });
  }
  return NextResponse.json({ ok: true, kept: Number(data ?? 0) });
}
