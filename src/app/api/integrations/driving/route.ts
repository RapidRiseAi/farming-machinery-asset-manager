import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { z } from "zod";
import { DRIVING_KINDS } from "@/lib/driving";
const eventSchema = z
  .object({
    event_id: z.string().trim().min(1).max(200),
    machine_id: z.string().min(1).max(200),
    driver_id: z.string().min(1).max(200),
    kind: z.enum(DRIVING_KINDS),
    occurred_at: z.iso.datetime({ offset: true }),
    location: z.string().max(200).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat == null) === (v.lng == null));
export async function POST(request: Request) {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = createServiceClient();
  const secret = await db
    .from("driver_connection_secrets")
    .select("connection_id")
    .eq("token_hash", createHash("sha256").update(match[1]).digest("hex"))
    .maybeSingle();
  if (secret.error)
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  if (!secret.data)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Bound received bytes, including chunked requests, before parsing JSON.
  const reader = request.body?.getReader();
  if (!reader)
    return NextResponse.json({ error: "invalid_event" }, { status: 400 });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        return NextResponse.json(
          { error: "payload_too_large" },
          { status: 413 },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: ReturnType<typeof eventSchema.safeParse>;
  try {
    parsed = eventSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!parsed.success)
    return NextResponse.json({ error: "invalid_event" }, { status: 400 });
  const event = parsed.data;
  const { data, error } = await db.rpc("ingest_driving_event", {
    p_connection: secret.data.connection_id,
    p_machine_external: event.machine_id,
    p_driver_external: event.driver_id,
    p_event_id: event.event_id,
    p_kind: event.kind,
    p_at: event.occurred_at,
    p_location: event.location ?? null,
    p_lat: event.lat ?? null,
    p_lng: event.lng ?? null,
  });
  if (error)
    return NextResponse.json(
      {
        error:
          error.code === "22023"
            ? "event_rejected"
            : error.code === "42501"
              ? "forbidden"
              : "unavailable",
      },
      {
        status:
          error.code === "22023" ? 409 : error.code === "42501" ? 403 : 503,
      },
    );
  return NextResponse.json({ ok: true, event_id: data });
}
