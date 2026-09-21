"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { currentFarmId, homePathFor, requireProfile } from "@/lib/auth";
import { TYRE_AXLES } from "@/lib/tyres";

/**
 * Buying, fitting, checking and scrapping tyres.
 *
 * ── Fitting goes through an RPC, not an insert ───────────────────────────────
 * `public.fit_tyre` takes the tyre off whatever it was on and puts it on the new machine in
 * one statement. A rotation is a removal and a fitment, and doing those as two round trips
 * from here is how a farm ends up with a tyre recorded in two places, or in none. The
 * database also holds the rule that only one fitment per tyre may be open, and a partial
 * unique index cannot be satisfied halfway through a pair of client calls.
 *
 * ── Money and meters are typed as a person types them ────────────────────────
 * Rands, and hours or kilometres with a decimal point or a comma. Converted here once;
 * everything below this line is cents and numerics.
 */

const READING_MAX = 10_000_000;

function bounce(code: string): never {
  redirect(`/tyres?error=${encodeURIComponent(code)}`);
}

async function requireFarmUser() {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  // Owner, manager and mechanic. Fitting a tyre is workshop work; an operator reports a
  // problem with one through the fault they already have.
  if (!farmId || !["owner", "manager", "mechanic", "rr_admin"].includes(profile.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { profile, farmId };
}

function dateOrNull(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bounce("tyre-bad-date");
  return v;
}

/** A decimal a person typed: "12,5" and "12.5" are the same number. */
function numberOrNull(raw: string, max = READING_MAX): number | null {
  const v = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) bounce("tyre-bad-number");
  return n;
}

/** Rands as typed to ex-VAT cents. */
function centsOrNull(raw: string): number | null {
  const n = numberOrNull(raw, 100_000_000);
  return n == null ? null : Math.round(n * 100);
}

function uuidOrNull(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^[0-9a-f-]{36}$/i.test(v)) bounce("tyre-missing");
  return v;
}

export async function addTyre(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireFarmUser();

  const supabase = await createClient();
  const { error } = await supabase.from("tyres").insert({
    farm_id: farmId,
    brand: String(formData.get("brand") ?? "").trim() || null,
    pattern: String(formData.get("pattern") ?? "").trim() || null,
    size: String(formData.get("size") ?? "").trim() || null,
    serial_no: String(formData.get("serial_no") ?? "").trim() || null,
    purchase_date: dateOrNull(String(formData.get("purchase_date") ?? "")),
    purchase_cost_cents: centsOrNull(String(formData.get("purchase_cost_cents") ?? "")),
    supplier: String(formData.get("supplier") ?? "").trim() || null,
    // Tread is millimetres, so a small ceiling: 100mm would be a typo, not a tyre.
    new_tread_mm: numberOrNull(String(formData.get("new_tread_mm") ?? ""), 100),
    notes: String(formData.get("notes") ?? "").trim() || null,
    created_by: profile.id,
  });
  if (error) bounce("tyre-save-failed");

  revalidatePath("/tyres");
  redirect("/tyres?saved=added");
}

export async function fitTyre(formData: FormData): Promise<void> {
  await requireFarmUser();

  const tyre = uuidOrNull(String(formData.get("tyre_id") ?? ""));
  const machine = uuidOrNull(String(formData.get("machine_id") ?? ""));
  if (!tyre) bounce("tyre-missing");
  if (!machine) bounce("tyre-need-machine");

  const axle = String(formData.get("axle") ?? "other").trim();
  if (!(TYRE_AXLES as readonly string[]).includes(axle)) bounce("tyre-bad-number");

  const supabase = await createClient();
  const { error } = await supabase.rpc("fit_tyre", {
    p_tyre: tyre,
    p_machine: machine,
    p_axle: axle,
    p_position: String(formData.get("position_label") ?? "").trim() || null,
    p_on: dateOrNull(String(formData.get("fitted_on") ?? "")),
    p_reading: numberOrNull(String(formData.get("fitted_reading") ?? "")),
  });
  if (error) bounce(error.code === "P0002" ? "tyre-missing" : "tyre-save-failed");

  revalidatePath("/tyres");
  redirect("/tyres?saved=fitted");
}

export async function removeTyre(formData: FormData): Promise<void> {
  await requireFarmUser();

  const tyre = uuidOrNull(String(formData.get("tyre_id") ?? ""));
  if (!tyre) bounce("tyre-missing");

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_tyre", {
    p_tyre: tyre,
    p_reason: String(formData.get("removal_reason") ?? "").trim() || null,
    p_on: dateOrNull(String(formData.get("removed_on") ?? "")),
    p_reading: numberOrNull(String(formData.get("removed_reading") ?? "")),
    p_scrap: String(formData.get("scrap") ?? "") === "on",
  });
  // P0002 is "that tyre is not fitted to anything", which is a mistake worth its own
  // sentence rather than the generic apology.
  if (error) bounce(error.code === "P0002" ? "tyre-not-fitted" : "tyre-save-failed");

  revalidatePath("/tyres");
  redirect("/tyres?saved=removed");
}

export async function recordTyreCheck(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireFarmUser();

  const tyre = uuidOrNull(String(formData.get("tyre_id") ?? ""));
  if (!tyre) bounce("tyre-missing");

  const tread = numberOrNull(String(formData.get("tread_mm") ?? ""), 100);
  if (tread == null) bounce("tyre-bad-number");

  const supabase = await createClient();
  const { error } = await supabase.from("tyre_checks").insert({
    farm_id: farmId,
    tyre_id: tyre,
    checked_on: dateOrNull(String(formData.get("checked_on") ?? "")) ?? undefined,
    tread_mm: tread,
    reading: numberOrNull(String(formData.get("reading") ?? "")),
    pressure_kpa: numberOrNull(String(formData.get("pressure_kpa") ?? ""), 2000),
    notes: String(formData.get("notes") ?? "").trim() || null,
    checked_by: profile.id,
  });
  if (error) bounce("tyre-save-failed");

  revalidatePath("/tyres");
  redirect("/tyres?saved=checked");
}
