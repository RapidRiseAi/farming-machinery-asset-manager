"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentFarmId, effectiveFarmRole, homePathFor, requireProfile, requireUsableFarm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorCode } from "@/lib/action-errors";
import { runOnce } from "@/lib/request-claim";
import { isUuid } from "@/lib/ids";
import { READINGS_IMPORT_MAX_BYTES } from "@/lib/limits";
import { readingsSheet } from "@/lib/import-staging";

const HERE = "/imports";

/**
 * Import review (task B5, 20261121110000). A sheet is staged, every row is decided by a person,
 * and only then is anything written. The database names the problems and refuses an unreviewed
 * accept (public.import_*); these actions read the form, call it, and say what happened.
 */
async function gate() {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${HERE}?error=no-farm`);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) redirect(`${homePathFor(profile.role)}?denied=1`);
  // The stop gate: a business that is not open writes nothing (the database refuses again).
  await requireUsableFarm(farmId, profile);
  return { farmId, supabase: await createClient() };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();

/** Upload a readings sheet into a new review (or the review the same file already has). */
export async function startReadingsImport(form: FormData) {
  return runOnce(form, "imports:start", async () => {
    const { farmId, supabase } = await gate();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) redirect(`${HERE}?error=import-empty`);
    if (file.size > READINGS_IMPORT_MAX_BYTES) redirect(`${HERE}?error=import-file-too-large`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const sheet = readingsSheet(bytes.toString("utf8"));
    if (!sheet.ok) redirect(`${HERE}?error=${sheet.error}`);

    const { data: opened, error } = await supabase.rpc("import_batch_open", {
      p_farm: farmId,
      p_source: "sheet",
      p_file_name: file.name.slice(0, 200),
      p_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    if (error) redirect(`${HERE}?error=${errorCode(error, "imports:open")}`);
    const batch = opened as { id: string; reused: boolean; status: string };
    // The same file again: back to the review it already has, staged once.
    if (batch.reused) return `${HERE}/${batch.id}?reused=1`;

    const { error: stageError } = await supabase.rpc("import_rows_stage", { p_batch: batch.id, p_rows: sheet.rows });
    if (stageError) {
      // Nothing half-staged is left looking like a review: the empty batch is cancelled.
      await supabase.rpc("import_batch_cancel", { p_batch: batch.id });
      redirect(`${HERE}?error=${errorCode(stageError, "imports:stage")}`);
    }
    revalidatePath(HERE);
    return `${HERE}/${batch.id}`;
  }, { whileRunning: `${HERE}?error=still-saving` });
}

/** Accept a row as read, accept it with the values the person checked, skip it, or undo. */
export async function decideImportRow(form: FormData) {
  const { supabase } = await gate();
  const batch = text(form, "batch_id");
  const row = text(form, "row_id");
  const back = isUuid(batch) ? `${HERE}/${batch}` : HERE;
  const decision = text(form, "decision");
  if (!isUuid(row) || !["accept", "skip", "pending"].includes(decision)) redirect(`${back}?error=import-invalid`);
  const machine = text(form, "machine_id");
  const date = text(form, "reading_date");
  const readingText = text(form, "reading").replace(/\s/g, "").replace(",", ".");
  const reading = readingText === "" ? null : Number(readingText);
  if (machine && !isUuid(machine)) redirect(`${back}?error=import-invalid`);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) redirect(`${back}?error=import-invalid`);
  if (reading !== null && !Number.isFinite(reading)) redirect(`${back}?error=import-invalid`);
  const { error } = await supabase.rpc("import_row_decide", {
    p_row: row,
    p_decision: decision,
    p_machine: machine || null,
    p_date: date || null,
    p_reading: reading,
  });
  if (error) redirect(`${back}?error=${errorCode(error, "imports:decide")}#row-${row}`);
  revalidatePath(back);
  redirect(`${back}#row-${row}`);
}

/** Write every accepted row, once. */
export async function confirmImport(form: FormData) {
  return runOnce(form, "imports:confirm", async () => {
    const { supabase } = await gate();
    const batch = text(form, "batch_id");
    if (!isUuid(batch)) redirect(`${HERE}?error=import-invalid`);
    const { data, error } = await supabase.rpc("import_batch_confirm", { p_batch: batch });
    if (error) redirect(`${HERE}/${batch}?error=${errorCode(error, "imports:confirm")}`);
    const result = data as { written: number; skipped: number };
    revalidatePath(HERE);
    revalidatePath("/machines");
    return `${HERE}/${batch}?written=${result.written}&skipped=${result.skipped}`;
  }, { whileRunning: `${HERE}?error=still-saving` });
}

export async function cancelImport(form: FormData) {
  const { supabase } = await gate();
  const batch = text(form, "batch_id");
  if (!isUuid(batch)) redirect(`${HERE}?error=import-invalid`);
  const { error } = await supabase.rpc("import_batch_cancel", { p_batch: batch });
  if (error) redirect(`${HERE}/${batch}?error=${errorCode(error, "imports:cancel")}`);
  revalidatePath(HERE);
  redirect(`${HERE}?cancelled=1`);
}
