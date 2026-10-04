import { NextResponse } from "next/server";
import { memberQr } from "@/lib/member-qr";
import { getProfile } from "@/lib/auth";
import { sameOrigin } from "@/lib/security/same-origin";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { uploadFaultMedia } from "@/lib/fault-media";
import { readBoundedFormData } from "@/lib/security/bounded-form";
import { rememberName } from "@/app/(public)/m/[token]/remembered-name";

export const dynamic = "force-dynamic";

const URGENCIES = ["can_work", "limping", "stopped"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse an optional lat/lng pair from the form; returns {} unless both are valid. */
function geoFields(form: FormData): { lat?: number; lng?: number } {
  if (!String(form.get("lat") ?? "").trim() || !String(form.get("lng") ?? "").trim()) return {};
  const lat = Number(form.get("lat"));
  const lng = Number(form.get("lng"));
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return {};
}

/**
 * Member-only fault reporting from a vehicle QR. The database command derives the
 * reporter from the session and checks farm membership inside the write transaction.
 * A service client uploads media only after that authenticated capture succeeds.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await readBoundedFormData(request, 16 * 1024 * 1024);
  } catch (error) {
    return NextResponse.json({ error: "bad_request" }, { status: error instanceof RangeError ? 413 : 400 });
  }

  const token = String(form.get("token") ?? "");
  const clientId=String(form.get("client_id")??"");
  if(clientId&&!UUID_PATTERN.test(clientId)) return NextResponse.json({error:"invalid_fault"},{status:400});
  if (!await memberQr(token)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const profile = await getProfile();
  const description = String(form.get("description") ?? "").trim();
  const urgencyRaw = String(form.get("urgency") ?? "can_work");
  const urgency = URGENCIES.includes(urgencyRaw) ? urgencyRaw : "can_work";
  const category = String(form.get("category") ?? "").trim() || null;
  const reporter = profile?.name ?? null;
  if (!UUID_PATTERN.test(token)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (
    !description ||
    description.length > 2000 ||
    (category?.length ?? 0) > 80 ||
    (reporter?.length ?? 0) > 200
  ) {
    return NextResponse.json({ error: "invalid_fault" }, { status: 400 });
  }

  let svc: ReturnType<typeof createServiceClient>;
  try {
    svc = createServiceClient();
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  const coords = geoFields(form);
  const db=await createClient();
  const { data, error } = await db.rpc("record_member_qr", {p_token:token,p_kind:"fault",p_client:clientId||null,p_fields:{
    p_token: token,
    p_description: description,
    p_urgency: urgency,
    p_category: category,
    p_reporter: reporter,
    p_lat: coords.lat ?? null,
    p_lng: coords.lng ?? null,
  }});
  if (error) {
    console.error("[public-qr] fault capture RPC failed", { code: error.code });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  const result = data as { ok?: boolean; error?: string; fault_id?: string; farm_id?: string } | null;
  if (result?.ok !== true || !result.fault_id || !result.farm_id) {
    const code = result?.error ?? "unavailable";
    const status = code === "not_found" ? 404 : code === "rate_limited" ? 429 : code === "invalid_fault" ? 400 : 503;
    return NextResponse.json({ error: code }, { status });
  }

  const media = await uploadFaultMedia(svc, form, result.farm_id, result.fault_id, profile?.id ?? null,clientId||undefined);
  // Only after the fault was recorded, as the kiosk's reading and fuel actions do: the
  // phone remembers who reported it, and a cleared name field forgets it.
  await rememberName(reporter);
  return NextResponse.json({ ok: true, fault_id: result.fault_id, media_saved: media.ok });
}
