"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { MACHINE_TYPES, MACHINE_STATUSES, METER_TYPES } from "@/lib/machine-options";
import { validateCsv, MAX_IMPORT_ROWS } from "./import/csv";

function str(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function intOrNull(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v == null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function numOrNull(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const inList = (list: readonly string[], v: string) => list.includes(v);

/** Parse a Rand amount string to integer cents, ex-VAT (no float drift). */
function priceToCents(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v == null) return null;
  const cleaned = v.replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number.parseInt(whole || "0", 10) * 100 + Number.parseInt((frac + "00").slice(0, 2), 10);
  return Number.isFinite(cents) ? cents : null;
}

/** Validate that a chosen assigned-operator id is an active user of this farm.
 *  Returns the id when valid, or null (unassigns) — never lets a cross-farm id through. */
async function validOperatorId(
  supabase: SupabaseClient,
  farmId: string,
  raw: string | null,
): Promise<string | null> {
  if (!raw) return null;
  const { data } = await supabase
    .from("users")
    .select("id")
    .eq("id", raw)
    .eq("farm_id", farmId)
    .eq("active", true)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? raw : null;
}

/** Extra optional machine fields shared by create + update. */
function extraFields(fd: FormData) {
  return {
    purchase_date: str(fd, "purchase_date"),
    purchase_price_cents: priceToCents(fd, "purchase_price"),
    supplier: str(fd, "supplier"),
    warranty_expiry_date: str(fd, "warranty_expiry_date"),
    warranty_expiry_hours: numOrNull(fd, "warranty_expiry_hours"),
    location: str(fd, "location"),
    notes: str(fd, "notes"),
    // Finance details (FR-3.2). Money in ex-VAT cents; the DB trigger derives a
    // finance-interest cost entry from these (see migration 0211).
    finance_provider: str(fd, "finance_provider"),
    finance_total_cents: priceToCents(fd, "finance_total"),
    finance_monthly_cents: priceToCents(fd, "finance_monthly"),
    finance_term_months: intOrNull(fd, "finance_term_months"),
    finance_interest_bps: intOrNull(fd, "finance_interest_bps"),
  };
}

export async function createMachine(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) redirect("/machines?error=No+farm+context");

  const name = str(formData, "name");
  const type = String(formData.get("type") ?? "");
  if (!name) redirect("/machines/new?error=Name+is+required");
  if (!inList(MACHINE_TYPES, type)) redirect("/machines/new?error=Invalid+type");

  const meterInput = String(formData.get("meter_type") ?? "hours");
  const meter_type = inList(METER_TYPES, meterInput) ? meterInput : "hours";
  const current_reading = numOrNull(formData, "current_reading");

  const supabase = await createClient();
  const assigned_operator_id = await validOperatorId(supabase, profile.farm_id, str(formData, "assigned_operator_id"));
  const { data, error } = await supabase
    .from("machines")
    .insert({
      farm_id: profile.farm_id,
      name,
      type,
      make: str(formData, "make"),
      model: str(formData, "model"),
      year: intOrNull(formData, "year"),
      serial_no: str(formData, "serial_no"),
      reg_no: str(formData, "reg_no"),
      meter_type,
      current_reading,
      current_reading_date: current_reading != null ? new Date().toISOString().slice(0, 10) : null,
      status: "active",
      assigned_operator_id,
      ...extraFields(formData),
    })
    .select("id")
    .single();

  if (error || !data) redirect(`/machines/new?error=${encodeURIComponent(error?.message ?? "Failed")}`);

  revalidatePath("/machines");
  redirect(`/machines/${data.id}`);
}

export async function updateMachine(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/machines?error=Missing+id");

  const name = str(formData, "name");
  const type = String(formData.get("type") ?? "");
  const status = String(formData.get("status") ?? "active");
  if (!name) redirect(`/machines/${id}?error=Name+is+required`);
  if (!inList(MACHINE_TYPES, type)) redirect(`/machines/${id}?error=Invalid+type`);
  if (!inList(MACHINE_STATUSES, status)) redirect(`/machines/${id}?error=Invalid+status`);

  const meterInput = String(formData.get("meter_type") ?? "hours");
  const meter_type = inList(METER_TYPES, meterInput) ? meterInput : "hours";

  const supabase = await createClient();
  // RLS scopes this to the caller's farm; profile.farm_id gates the operator select.
  const assigned_operator_id = profile.farm_id
    ? await validOperatorId(supabase, profile.farm_id, str(formData, "assigned_operator_id"))
    : null;
  const { error } = await supabase
    .from("machines")
    .update({
      name,
      type,
      make: str(formData, "make"),
      model: str(formData, "model"),
      year: intOrNull(formData, "year"),
      serial_no: str(formData, "serial_no"),
      reg_no: str(formData, "reg_no"),
      meter_type,
      status,
      assigned_operator_id,
      ...extraFields(formData),
    })
    .eq("id", id);

  if (error) redirect(`/machines/${id}?error=${encodeURIComponent(error.message)}`);

  revalidatePath(`/machines/${id}`);
  redirect(`/machines/${id}?saved=1`);
}

/** Return an out-of-service machine to `active` (FR-7.5 revert). Owner/manager only;
 *  RLS scopes the update to the caller's farm. Retired/sold are left untouched. */
export async function returnMachineToService(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/machines?error=Missing+id");
  const supabase = await createClient();
  const { error } = await supabase
    .from("machines")
    .update({ status: "active" })
    .eq("id", id)
    .eq("status", "out_of_service");
  if (error) redirect(`/machines/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${id}`);
  redirect(`/machines/${id}?saved=1`);
}

/** Bulk import machines from a CSV posted by the import preview. The server
 *  re-parses and re-validates (the client preview is UX only) and inserts only
 *  the valid rows, farm-scoped. */
export async function importMachines(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  if (!profile.farm_id) redirect("/machines?error=No+farm+context");

  const csv = String(formData.get("csv") ?? "");
  if (!csv.trim()) redirect("/machines/import?error=No+CSV+provided");

  const parsed = validateCsv(csv);
  if (parsed.headerError) redirect("/machines/import?error=Invalid+CSV+header");

  const valid = parsed.rows.filter((r) => r.valid && r.machine).map((r) => r.machine!);
  if (valid.length === 0) redirect("/machines/import?error=No+valid+rows");
  if (valid.length > MAX_IMPORT_ROWS) redirect(`/machines/import?error=Too+many+rows`);

  const today = new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const { error } = await supabase.from("machines").insert(
    valid.map((m) => ({
      farm_id: profile.farm_id,
      name: m.name,
      type: m.type,
      make: m.make,
      model: m.model,
      year: m.year,
      serial_no: m.serial_no,
      reg_no: m.reg_no,
      meter_type: m.meter_type,
      current_reading: m.current_reading,
      current_reading_date: m.current_reading != null ? today : null,
      status: m.status,
      notes: m.notes,
    }))
  );

  if (error) redirect(`/machines/import?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/machines");
  redirect(`/machines?imported=${valid.length}`);
}
