import { NextResponse } from "next/server";
import { effectiveFarmRole, getProfile, farmIsUsable } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { sameOrigin } from "@/lib/security/same-origin";
import { readBoundedFormData } from "@/lib/security/bounded-form";
import { canEditJobWork, canReviewJob } from "@/lib/jobcard-workflow";
import { FUNCTION_BODY_MAX_BYTES, maxBytesForMime } from "@/lib/limits";
import { commitUpload, failUpload, verifiedIntentFor } from "@/lib/upload/server";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Upload evidence, then commit the attachment and received supplier cost atomically. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return reject("forbidden", 403);
  const profile = await getProfile();
  if (!profile?.active) return reject("forbidden", 403);
  let form: FormData;
  try { form = await readBoundedFormData(request, FUNCTION_BODY_MAX_BYTES); }
  catch (error) { return reject("bad_request", error instanceof RangeError ? 413 : 400); }

  const id = String(form.get("job_card_id") ?? "");
  // The current page sends the file straight to Storage first (the upload pipeline) and
  // names it here; the upload's id is then the capture id, so a retry saves it once.
  const intentId = String(form.get("upload_intent_id") ?? "");
  const capture = intentId || String(form.get("capture_id") ?? "");
  const kind = String(form.get("kind") ?? "photo");
  if (!UUID.test(id) || !UUID.test(capture) || !["photo", "quote", "invoice"].includes(kind)) return reject("missing_fields");
  const supabase = await createClient();
  const { data: job, error: lookupError } = await supabase.from("job_cards")
    .select("id,farm_id,workshop_id,work_mode,status,locked,vat_rate_bps")
    .eq("id", id).is("deleted_at", null).maybeSingle();
  if (lookupError) return reject("save-failed", 500);
  if (!job) return reject("not_found", 404);
  const role = profile.role === "workshop" ? "workshop" : await effectiveFarmRole(job.farm_id, profile);
  if (!(await farmIsUsable(job.farm_id, profile))) return NextResponse.json({ error: "farm-not-active" }, { status: 402 });
  const isProvider = role === "workshop" && profile.workshop_id === job.workshop_id;
  const isReceiver = canReviewJob(role);
  const invoice = kind === "invoice";
  const external = job.work_mode === "external";
  if ((!external && kind !== "photo") || (invoice && !["completed", "approved"].includes(job.status))) return reject("job-invalid-transition", 409);
  if (invoice ? !(isProvider || isReceiver) : !canEditJobWork(job, role, profile.workshop_id)) return reject("forbidden", 403);

  const file = form.get("file");
  let direct: Awaited<ReturnType<typeof verifiedIntentFor>> | null = null;
  if (intentId) {
    direct = await verifiedIntentFor(intentId, profile.id, { kind: "job_card", targetId: id });
    if (direct.state === "refused") return reject(direct.code, direct.status);
    if (kind === "photo" && direct.intent.media_class !== "photo") return reject("bad-file-type");
  } else {
    // An installed older page posts the file itself (bounded by Vercel's 4.5 MB).
    if (!(file instanceof File) || file.size === 0) return reject("receipt");
    if (file.size > maxBytesForMime(file.type)) return reject("file_too_large", 413);
    if (!(file.type.startsWith("image/") || (kind !== "photo" && file.type === "application/pdf"))) return reject("bad-file-type");
  }

  const rawAmount = String(form.get("invoice_amount") ?? "").trim();
  const amount = rawAmount ? parseRandsToCents(rawAmount) : null;
  if (rawAmount && (amount == null || !Number.isSafeInteger(amount) || amount < 0)) return reject("job-line-price");
  if (amount != null && (!invoice || (job.workshop_id && !isProvider))) return reject("forbidden", 403);
  if (invoice) {
    const { data: linked, error } = await supabase.from("work_requests").select("id").eq("job_card_id", id).is("deleted_at", null).limit(1);
    if (error) return reject("save-failed", 500);
    if (amount != null && linked?.length) return reject("job-linked-invoice", 409);
    // Standalone supplier bills must replace estimated work costs, including an
    // explicit zero for no-charge work. Receiving farms may still file proof for
    // a connected supplier whose amount is recorded by that supplier.
    if (!linked?.length && (!job.workshop_id || isProvider) && amount == null) return reject("job-line-price");
  }

  const storage = createServiceClient().storage.from("jobcard-photos");
  let storagePath: string;
  let uploadError: { statusCode?: unknown; name?: string } | null = null;
  if (direct?.state === "verified") {
    storagePath = direct.intent.object_path;
  } else {
    const legacy = file as File;
    const ext = legacy.type === "application/pdf" ? "pdf" : "image";
    storagePath = `${job.farm_id}/${id}/${kind}-${capture}.${ext}`;
    const uploaded = await storage.upload(storagePath, new Uint8Array(await legacy.arrayBuffer()), { contentType: legacy.type, upsert: false });
    const failed = uploaded.error as { statusCode?: unknown; name?: string } | null;
    uploadError = failed;
    // The same capture retries the same path after an interrupted response.
    if (failed && !["409", "Duplicate"].includes(String(failed.statusCode ?? failed.name))) return reject("upload_failed", 500);
  }
  const exAmount = amount != null && String(form.get("incl_vat")) === "1" ? exVatCents(amount, job.vat_rate_bps) : amount;
  const { error } = await supabase.rpc("record_job_card_media", {
    p_job: id, p_capture: capture, p_kind: kind, p_storage_path: storagePath,
    p_amount: exAmount, p_note: String(form.get("note") ?? "").trim() || null,
  });
  if (error) {
    // A network failure is ambiguous: retain its capture and file for an idempotent retry.
    // A refusal removes the file (and releases a direct upload's reservation).
    const refused = Boolean(error.code && /^(22|23|42|P0)/.test(error.code));
    if (refused && direct?.state === "verified") await failUpload(direct.svc, direct.intent, "refused");
    else if (refused && !uploadError) await storage.remove([storagePath]);
    return reject(error.code === "42501" ? "forbidden" : "save-failed", error.code === "42501" ? 403 : 409);
  }
  if (direct?.state === "verified") {
    const committed = await commitUpload(supabase, direct.svc, direct.intent, { recordId: capture });
    if (committed.state === "refused") return reject(committed.code, committed.status);
  }
  return NextResponse.json({ ok: true, stored: true, invoiceRecorded: amount != null });
}
