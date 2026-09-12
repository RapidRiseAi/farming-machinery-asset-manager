import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { uploadFaultMedia } from "@/lib/fault-media";
import { sameOrigin } from "@/lib/security/same-origin";
import { parseSyncEnvelope } from "@/lib/offline/envelope";
import { readBoundedFormData } from "@/lib/security/bounded-form";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let form: FormData;
  try { form = await readBoundedFormData(request, 16 * 1024 * 1024); }
  catch (error) {
    return NextResponse.json({ error: "bad_request" }, { status: error instanceof RangeError ? 413 : 400 });
  }
  const parsed = parseSyncEnvelope(form);
  if (!parsed) return NextResponse.json({ error: "bad_mutation" }, { status: 400 });
  const { scope, type, clientId, clientTs, fields, actorId } = parsed;
  if (scope === "app" && !sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const profile = scope === "app" ? await getProfile() : null;
    if (scope === "app" && (!profile || !profile.active)) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    // Shared-device drafts must not be adopted by another account. Legacy unowned
    // drafts are retained for review, never silently attributed to the current user.
    if (scope === "app" && actorId !== profile?.id) {
      return NextResponse.json({ error: "capture_account_mismatch" }, { status: 409 });
    }
    const svc = createServiceClient();
    const { data, error } = await svc.rpc("apply_offline_capture", {
      p_client: clientId, p_client_ts: clientTs, p_type: type, p_scope: scope,
      p_actor: profile?.id ?? null, p_fields: fields,
    });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404
        : error.code?.startsWith("22") ? 400 : 503;
      return NextResponse.json({ error: status === 503 ? "sync_unavailable" : "capture_rejected" }, { status });
    }
    const result = data as { status?: string; error?: string; entity_id?: string; farm_id?: string } | null;
    if (result?.error === "rate_limited") return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    if (result?.status === "needs_review") return NextResponse.json({ error: "capture_needs_review" }, { status: 409 });
    if (!result || !["applied", "conflict"].includes(result.status ?? "")) {
      return NextResponse.json({ error: "sync_unavailable" }, { status: 503 });
    }
    if (type === "report_fault" && result.status === "applied" && result.farm_id && result.entity_id) {
      // Media retries use the committed fault; they cannot create a second fault.
      const media = await uploadFaultMedia(svc, form, result.farm_id, result.entity_id, profile?.id ?? null, clientId);
      if (!media.ok) return NextResponse.json({ error: "media_retry", entity_id: result.entity_id }, { status: 503 });
    }
    return NextResponse.json({ status: result.status, client_id: clientId, entity_id: result.entity_id });
  } catch {
    return NextResponse.json({ error: "sync_unavailable" }, { status: 503 });
  }
}
