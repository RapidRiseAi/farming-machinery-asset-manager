"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { currentFarmId, homePathFor, requireProfile } from "@/lib/auth";
import {
  INCIDENT_KINDS,
  INCIDENT_STATUSES,
  requiredFor,
  type IncidentStatus,
} from "@/lib/incidents";

/**
 * Accidents and insurance claims.
 *
 * ── Money here is VAT-INCLUSIVE ──────────────────────────────────────────────
 * Every other amount in this product is ex-VAT cents with a rate captured beside it.
 * These are not: an excess and a settlement are figures a person copies off a letter from
 * their broker, and a screen that re-bases them would disagree with the document it was
 * copied from on every line. The columns are named `*_incl_cents` so nobody has to
 * remember, and the form says so under the fields.
 *
 * ── What this does NOT do ────────────────────────────────────────────────────
 * Post anything to the books. A settlement is money coming in against a repair whose cost
 * is already on a job card, and the shape of that entry is an open founder decision
 * (`docs/BILLING.md` §11b). Recording that a claim was paid and posting a credit are two
 * different acts; doing the second by implication would leave a ledger nobody can
 * reconcile against their bank.
 *
 * ── Why the required-field checks are here AND in SQL ────────────────────────
 * `incidents_lodged_ck` and `incidents_settled_ck` are the authority and stay it. These
 * mirror them so that a farmer marking a claim paid without the amount gets a sentence
 * about the amount rather than a constraint name, and `incidents.test.ts` walks every
 * status against both rules so the two cannot drift.
 */

async function requireFarmUser() {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") redirect("/admin/farms");
  const farmId = await currentFarmId(profile);
  // Owner and manager capture and update; everyone else reads. RLS allows any farm member
  // to write, so this is the narrower rule and it is deliberate: an accident record is
  // evidence, and evidence a driver can edit after the fact is worth less.
  if (!farmId || !["owner", "manager"].includes(profile.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { profile, farmId };
}

function bounce(code: string): never {
  redirect(`/incidents?error=${encodeURIComponent(code)}`);
}

function dateOrNull(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bounce("incident-bad-date");
  return v;
}

/** Rands as typed — "4 500,50" or "4500.50" — to VAT-inclusive cents. Blank is null. */
function centsOrNull(raw: string): number | null {
  const v = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) bounce("incident-bad-amount");
  return Math.round(n * 100);
}

function uuidOrNull(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^[0-9a-f-]{36}$/i.test(v)) bounce("incident-bad-id");
  return v;
}

/** The fields shared by capture and update, read once so the two cannot diverge. */
function readFields(formData: FormData) {
  const kind = String(formData.get("kind") ?? "").trim();
  const status = String(formData.get("status") ?? "reported").trim();
  if (!(INCIDENT_KINDS as readonly string[]).includes(kind)) bounce("incident-bad-kind");
  if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) bounce("incident-bad-status");

  const lodgedOn = dateOrNull(String(formData.get("claim_lodged_on") ?? ""));
  const settledCents = centsOrNull(String(formData.get("settled_incl_cents") ?? ""));
  const settledOn = dateOrNull(String(formData.get("settled_on") ?? ""));

  // Asked for before the database refuses, and worded as the missing thing rather than as
  // the rule: "a claim that has been paid needs the amount and the date" is something a
  // person can act on standing at a bakkie.
  const need = requiredFor(status as IncidentStatus);
  if (need.lodgedOn && !lodgedOn) bounce("incident-need-lodged");
  if (need.settlement && (settledCents == null || !settledOn)) bounce("incident-need-settlement");

  return {
    kind,
    status,
    location: String(formData.get("location") ?? "").trim() || null,
    description: String(formData.get("description") ?? "").trim() || null,
    driver_user_id: uuidOrNull(String(formData.get("driver_user_id") ?? "")),
    driver_name: String(formData.get("driver_name") ?? "").trim() || null,
    saps_case_number: String(formData.get("saps_case_number") ?? "").trim() || null,
    saps_station: String(formData.get("saps_station") ?? "").trim() || null,
    third_party_name: String(formData.get("third_party_name") ?? "").trim() || null,
    third_party_contact: String(formData.get("third_party_contact") ?? "").trim() || null,
    third_party_reg_no: String(formData.get("third_party_reg_no") ?? "").trim() || null,
    third_party_insurer: String(formData.get("third_party_insurer") ?? "").trim() || null,
    injuries: String(formData.get("injuries") ?? "") === "on",
    injury_notes: String(formData.get("injury_notes") ?? "").trim() || null,
    insurer: String(formData.get("insurer") ?? "").trim() || null,
    claim_number: String(formData.get("claim_number") ?? "").trim() || null,
    claim_lodged_on: lodgedOn,
    excess_incl_cents: centsOrNull(String(formData.get("excess_incl_cents") ?? "")),
    claimed_incl_cents: centsOrNull(String(formData.get("claimed_incl_cents") ?? "")),
    settled_incl_cents: settledCents,
    settled_on: settledOn,
    claim_notes: String(formData.get("claim_notes") ?? "").trim() || null,
    job_card_id: uuidOrNull(String(formData.get("job_card_id") ?? "")),
  };
}

export async function recordIncident(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireFarmUser();

  const machineId = uuidOrNull(String(formData.get("machine_id") ?? ""));
  if (!machineId) bounce("missing-machine");

  // Datetime-local posts "2026-06-14T09:30" with no zone. Read as the farm's own wall
  // clock, which is what somebody standing at the scene typed.
  const whenRaw = String(formData.get("occurred_at") ?? "").trim();
  const occurredAt = whenRaw === "" ? new Date().toISOString() : new Date(whenRaw).toISOString();
  if (occurredAt === "Invalid Date" || Number.isNaN(Date.parse(occurredAt))) bounce("incident-bad-date");

  const supabase = await createClient();
  const { error } = await supabase.from("incidents").insert({
    farm_id: farmId,
    machine_id: machineId,
    occurred_at: occurredAt,
    reported_by: profile.id,
    ...readFields(formData),
  });
  if (error) bounce("incident-save-failed");

  revalidatePath("/incidents");
  redirect("/incidents?saved=incident-added");
}

export async function updateIncident(formData: FormData): Promise<void> {
  await requireFarmUser();

  const id = uuidOrNull(String(formData.get("id") ?? ""));
  if (!id) bounce("incident-missing");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("incidents")
    // `machine_id` and `occurred_at` are NOT in the update path. Re-pointing an accident at
    // a different vehicle or a different day changes what the record says happened, on a
    // row a farm may later hand to an insurer or a court. A mistake is removed and
    // recaptured, which leaves both acts in `audit_log`.
    .update(readFields(formData))
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) bounce("incident-save-failed");
  // RLS answers success with zero rows to somebody it refuses. Saying "saved" there would
  // be the screen reporting a change the database declined to make.
  if (!data || data.length === 0) bounce("incident-missing");

  revalidatePath("/incidents");
  redirect("/incidents?saved=incident-updated");
}

/** Soft delete, per the global convention: off the screen, not out of the history. */
export async function removeIncident(formData: FormData): Promise<void> {
  const { profile } = await requireFarmUser();

  const id = uuidOrNull(String(formData.get("id") ?? ""));
  if (!id) bounce("incident-missing");

  const supabase = await createClient();
  // Checked BEFORE the write. A soft delete makes the row fail its own SELECT policy, so
  // asking the update to return it asks for the row the policy has just been told to hide.
  const { data: found } = await supabase
    .from("incidents")
    .select("id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!found) bounce("incident-missing");

  const { error } = await supabase
    .from("incidents")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) bounce("incident-save-failed");

  revalidatePath("/incidents");
  redirect("/incidents?saved=incident-removed");
}
