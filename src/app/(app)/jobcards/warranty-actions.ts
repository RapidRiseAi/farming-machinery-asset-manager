"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { currentFarmId, requireProfile } from "@/lib/auth";
import { WARRANTY_STATUSES, requiredFor, type WarrantyStatus } from "@/lib/warranty-claims";

/**
 * Claiming a repair back from the dealer.
 *
 * == Money is EX-VAT here =====================================================
 * Unlike the insurance side, where the figures are copied off a letter. A warranty claim
 * is measured against a job card, whose parts, labour and totals are ex-VAT with a rate
 * captured beside them, and a claim on a different basis could not be compared with the
 * repair it is about. The form says so under the fields.
 *
 * == What the database refuses, and why this asks first =======================
 * A claim larger than its own job card (a trigger, because the limit lives on another
 * table), a paid claim with no amount or date, a sent claim with no send date, and a
 * second live claim against the same repair. Those are the authority; these checks exist
 * so a farmer gets a sentence rather than a constraint name, and `warranty-claims.test.ts`
 * walks every status against the same two rules.
 */

function bounce(jobCardId: string, code: string): never {
  redirect(`/jobcards/${jobCardId}?error=${encodeURIComponent(code)}`);
}

async function requireFarmUser(jobCardId: string) {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  // Owner, manager and mechanic. A repair is claimed back by whoever deals with the
  // dealer, and on most farms that is the workshop. RLS allows any farm member to write;
  // this is the narrower rule and it keeps an operator from filing money claims.
  if (!farmId || !["owner", "manager", "mechanic", "rr_admin"].includes(profile.role)) {
    bounce(jobCardId, "forbidden");
  }
  return { profile, farmId };
}

function dateOrNull(jobCardId: string, raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bounce(jobCardId, "warranty-bad-date");
  return v;
}

/** Rands as typed to ex-VAT cents. Blank is null, which means "not known yet". */
function centsOrNull(jobCardId: string, raw: string): number | null {
  const v = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) bounce(jobCardId, "warranty-bad-amount");
  return Math.round(n * 100);
}

/** Everything both the create and the update path read, so the two cannot diverge. */
function readFields(jobCardId: string, formData: FormData) {
  const status = String(formData.get("status") ?? "draft").trim();
  if (!(WARRANTY_STATUSES as readonly string[]).includes(status)) {
    bounce(jobCardId, "warranty-bad-status");
  }

  const submittedOn = dateOrNull(jobCardId, String(formData.get("submitted_on") ?? ""));
  const decidedOn = dateOrNull(jobCardId, String(formData.get("decided_on") ?? ""));
  const recovered = centsOrNull(jobCardId, String(formData.get("recovered_ex_vat_cents") ?? ""));

  const need = requiredFor(status as WarrantyStatus);
  if (need.submittedOn && !submittedOn) bounce(jobCardId, "warranty-need-submitted");
  if (need.payout && (recovered == null || !decidedOn)) bounce(jobCardId, "warranty-need-payout");

  return {
    supplier: String(formData.get("supplier") ?? "").trim() || null,
    reference: String(formData.get("reference") ?? "").trim() || null,
    status,
    submitted_on: submittedOn,
    decided_on: decidedOn,
    claimed_ex_vat_cents: centsOrNull(jobCardId, String(formData.get("claimed_ex_vat_cents") ?? "")),
    recovered_ex_vat_cents: recovered,
    notes: String(formData.get("notes") ?? "").trim() || null,
  };
}

/** Turn a database refusal into the sentence that names what to do about it. */
function bounceForError(jobCardId: string, error: { code?: string; message?: string }): never {
  if (error.code === "23505") bounce(jobCardId, "warranty-duplicate");
  if (error.code === "23514") bounce(jobCardId, "warranty-too-much");
  bounce(jobCardId, "warranty-save-failed");
}

export async function startWarrantyClaim(formData: FormData): Promise<void> {
  const jobCardId = String(formData.get("job_card_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobCardId)) redirect("/jobcards?error=warranty-missing");
  const { profile, farmId } = await requireFarmUser(jobCardId);

  const machineId = String(formData.get("machine_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(machineId)) bounce(jobCardId, "warranty-missing");

  // What the cover looked like the day the claim was raised, carried on the row. The
  // machine's warranty dates can be corrected later; what was believed at the time is part
  // of the record, and it is what a dealer was told.
  const coveredByDate = String(formData.get("covered_by_date") ?? "");
  const coveredByHours = String(formData.get("covered_by_hours") ?? "");
  const tri = (v: string) => (v === "true" ? true : v === "false" ? false : null);

  const supabase = await createClient();
  const { error } = await supabase.from("warranty_claims").insert({
    farm_id: farmId,
    machine_id: machineId,
    job_card_id: jobCardId,
    covered_by_date: tri(coveredByDate),
    covered_by_hours: tri(coveredByHours),
    created_by: profile.id,
    ...readFields(jobCardId, formData),
  });
  if (error) bounceForError(jobCardId, error);

  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=warranty-added`);
}

export async function updateWarrantyClaim(formData: FormData): Promise<void> {
  const jobCardId = String(formData.get("job_card_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobCardId)) redirect("/jobcards?error=warranty-missing");
  await requireFarmUser(jobCardId);

  const id = String(formData.get("id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) bounce(jobCardId, "warranty-missing");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("warranty_claims")
    // `job_card_id` and `machine_id` are not in the update path. Moving a claim onto a
    // different repair changes what it is a claim FOR, on a record a dealer may be shown.
    .update(readFields(jobCardId, formData))
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) bounceForError(jobCardId, error);
  // RLS answers success with zero rows to somebody it refuses, and saying "saved" there
  // would report a change the database declined to make.
  if (!data || data.length === 0) bounce(jobCardId, "warranty-missing");

  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=warranty-updated`);
}

/** Soft delete, which also frees the repair for a fresh claim. */
export async function removeWarrantyClaim(formData: FormData): Promise<void> {
  const jobCardId = String(formData.get("job_card_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobCardId)) redirect("/jobcards?error=warranty-missing");
  const { profile } = await requireFarmUser(jobCardId);

  const id = String(formData.get("id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) bounce(jobCardId, "warranty-missing");

  const supabase = await createClient();
  // Checked before the write: a soft delete makes the row fail its own SELECT policy, so
  // asking the update to return it asks for the row the policy has just been told to hide.
  const { data: found } = await supabase
    .from("warranty_claims")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!found) bounce(jobCardId, "warranty-missing");

  const { error } = await supabase
    .from("warranty_claims")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) bounce(jobCardId, "warranty-save-failed");

  revalidatePath(`/jobcards/${jobCardId}`);
  redirect(`/jobcards/${jobCardId}?saved=warranty-removed`);
}
