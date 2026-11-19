"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentFarmId, effectiveFarmRole, getFarmPlan, homePathFor, requireProfile, requireUsableFarm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { errorCode } from "@/lib/action-errors";
import { runOnce } from "@/lib/request-claim";
import { isUuid } from "@/lib/ids";
import { PDF_MAX_BYTES, PHOTO_MAX_BYTES } from "@/lib/limits";
import { configuredManualReader, runManualRead, type ManualReadRefusal } from "@/lib/manuals";
import { holdBudget, settleHold } from "@/lib/ai-usage/ledger";
import { sniffContainer } from "@/lib/upload/sniff";

/**
 * Making an asset's manual searchable (task B5, 20261121120000). Owners and managers; Complete with
 * the manual_questions flag and a configured reader. The pages are read inside a hold on the
 * owner's spending limit, then the server stores their text (public.manual_index_put). The file
 * is read from where it already is; nothing is copied, so nothing is stored or charged twice.
 */
async function gate(form: FormData) {
  const profile = await requireProfile();
  const machineId = String(form.get("machine_id") ?? "");
  const back = isUuid(machineId) ? `/machines/${machineId}` : "/machines";
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${back}?error=no-farm`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) redirect(`${homePathFor(profile.role)}?denied=1`);
  await requireUsableFarm(farmId, profile);
  return { profile, farmId, machineId, back, supabase: await createClient() };
}

const REFUSALS: Record<ManualReadRefusal, string> = {
  plan: "manual-questions-off",
  spend_refused: "import-extraction-spend",
  provider_failed: "import-extraction-failed",
};

export async function indexManual(form: FormData) {
  return runOnce(form, "manuals:index", async () => {
    const { profile, farmId, machineId, back, supabase } = await gate(form);
    const attachmentId = String(form.get("attachment_id") ?? "");
    const title = String(form.get("title") ?? "").trim();
    if (!isUuid(attachmentId) || !title) redirect(`${back}?error=manual-invalid`);
    const reader = configuredManualReader();
    if (!reader) redirect(`${back}?error=manual-questions-off`);
    const { data: available } = await supabase.rpc("manual_questions_available", { p_farm: farmId });
    if (available !== true) redirect(`${back}?error=manual-questions-off`);

    // The person's own session must see the document (its policies decide), and it must be this
    // asset's document.
    const { data: doc, error: docError } = await supabase.from("attachments")
      .select("id, farm_id, parent_type, parent_id, kind, storage_path")
      .eq("id", attachmentId).is("deleted_at", null).maybeSingle();
    if (docError) redirect(`${back}?error=${errorCode(docError, "manuals:document")}`);
    const row = doc as { farm_id: string; parent_type: string; parent_id: string; kind: string; storage_path: string | null } | null;
    if (!row || row.farm_id !== farmId || row.parent_type !== "machine" || row.parent_id !== machineId || row.kind !== "doc" || !row.storage_path) {
      redirect(`${back}?error=manual-not-a-manual`);
    }

    const service = createServiceClient();
    const { data: blob, error: fileError } = await service.storage.from("machine-docs").download(row.storage_path);
    if (fileError || !blob) redirect(`${back}?error=import-extraction-failed`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = sniffContainer(bytes.subarray(0, 64));
    if (!type || !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(type)) redirect(`${back}?error=manual-not-a-manual`);
    if (bytes.length > (type === "application/pdf" ? PDF_MAX_BYTES : PHOTO_MAX_BYTES)) redirect(`${back}?error=upload-too-large`);

    const result = await runManualRead({
      reader,
      input: { bytes, contentType: type },
      plan: await getFarmPlan(farmId),
      hold: (units, model) => holdBudget({ farmId, userId: profile.id, feature: "ai_answer", model, units }),
      settle: settleHold,
    });
    if (!result.ok) redirect(`${back}?error=${REFUSALS[result.reason]}`);
    const { error } = await service.rpc("manual_index_put", {
      p_attachment: attachmentId,
      p_title: title.slice(0, 80),
      p_provider: reader.name,
      p_pages: result.pages,
      p_by: profile.id,
    });
    if (error) redirect(`${back}?error=${errorCode(error, "manuals:index")}`);
    revalidatePath(back);
    return `${back}?manual=indexed`;
  }, { whileRunning: "/machines?error=still-saving" });
}

export async function removeManual(form: FormData) {
  const { back, supabase } = await gate(form);
  const attachmentId = String(form.get("attachment_id") ?? "");
  if (!isUuid(attachmentId)) redirect(`${back}?error=manual-invalid`);
  const { error } = await supabase.rpc("manual_index_remove", { p_attachment: attachmentId });
  if (error) redirect(`${back}?error=${errorCode(error, "manuals:remove")}`);
  revalidatePath(back);
  redirect(`${back}?manual=removed`);
}
