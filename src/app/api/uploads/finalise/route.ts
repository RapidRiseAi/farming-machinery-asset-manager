import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { sameOrigin } from "@/lib/security/same-origin";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { commitUpload, storageReader, verifyUpload } from "@/lib/upload/server";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;
/** Records whose file is an ordinary attachment, finished here. The rest finish in their own route. */
const GENERIC = new Set(["machine", "fault", "checklist_instance", "work_request", "finance_agreement", "asset_contract", "chat_message"]);
const KINDS = new Set(["photo", "voice", "doc", "invoice"]);

/**
 * Finish a direct upload of an ordinary attachment: read the stored object back and judge
 * its real bytes, then save the attachment in the person's own session. Safe to call again
 * after a lost response: the second call answers the first one's result.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const profile = await getProfile();
  if (!profile?.active) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const body = (await request.json().catch(() => null)) as { intentId?: unknown; attachmentKind?: unknown } | null;
  const kind = typeof body?.attachmentKind === "string" && KINDS.has(body.attachmentKind)
    ? (body.attachmentKind as "photo" | "voice" | "doc" | "invoice") : undefined;

  const svc = createServiceClient();
  const verified = await verifyUpload(svc, storageReader(), String(body?.intentId ?? ""), profile.id);
  if (verified.state === "refused") {
    return NextResponse.json({ error: verified.code }, { status: verified.status, headers: HEADERS });
  }
  if (!GENERIC.has(verified.intent.target_kind)) {
    return NextResponse.json({ error: "upload-target" }, { status: 400, headers: HEADERS });
  }
  const committed = await commitUpload(await createClient(), svc, verified.intent, { attachmentKind: kind });
  if (committed.state === "refused") {
    return NextResponse.json({ error: committed.code }, { status: committed.status, headers: HEADERS });
  }
  return NextResponse.json({ ok: true, recordId: committed.recordId, intentId: verified.intent.id }, { headers: HEADERS });
}
