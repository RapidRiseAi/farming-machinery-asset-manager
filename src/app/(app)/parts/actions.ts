"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { homePathFor, requireProfile } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";
import { parseRandsToCents, exVatCents } from "@/lib/money";

// Who may maintain the parts catalogue (Scope §6): farm crew for their own farm's
// rows, RR admin for the GLOBAL library. Operators/workshop are read-only.
async function requireCatalogueManager() {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") return { profile, farmId: null, isAdmin: true } as const;
  const state = await farmPermissionState(profile);
  if (!state.farmId || !state.role || !["owner", "manager", "mechanic"].includes(state.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { profile, farmId: state.farmId, isAdmin: false } as const;
}

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

/** Resolve the cost input to ex-VAT cents (Scope §6). Catalogue costs are captured
 *  ex-VAT by default; tick incl_vat to convert a VAT-inclusive figure down. */
function costToExVat(fd: FormData): number | null {
  const cents = parseRandsToCents(String(fd.get("typical_cost") ?? ""));
  if (cents == null) return null;
  if (String(fd.get("incl_vat") ?? "") === "1") {
    const bps = Number(fd.get("vat_rate_bps")) || 1500;
    return exVatCents(cents, bps);
  }
  return cents;
}

export async function createPart(formData: FormData) {
  const { profile, farmId } = await requireCatalogueManager();
  const partNo = s(formData, "part_no");
  if (!partNo) redirect("/parts?error=Part+number+is+required");

  // RR admin (no farm) maintains the GLOBAL catalogue (farm_id null); everyone else
  // creates rows scoped to their own farm.
  const supabase = await createClient();
  const { error } = await supabase.from("parts_catalogue").insert({
    farm_id: farmId,
    part_no: partNo,
    description: s(formData, "description"),
    supplier: s(formData, "supplier"),
    category: s(formData, "category"),
    typical_cost_cents: costToExVat(formData),
    created_by: profile.id,
  });
  if (error) redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/parts");
  redirect("/parts?saved=1");
}

export async function updatePart(formData: FormData) {
  const { farmId, isAdmin } = await requireCatalogueManager();
  const id = String(formData.get("id") ?? "");
  const partNo = s(formData, "part_no");
  if (!id || !partNo) redirect("/parts?error=Part+number+is+required");

  const supabase = await createClient();
  // RLS restricts this to own-farm rows (or global rows for RR admin); a blocked row
  // simply updates nothing.
  let query = supabase
    .from("parts_catalogue")
    .update({
      part_no: partNo,
      description: s(formData, "description"),
      supplier: s(formData, "supplier"),
      category: s(formData, "category"),
      typical_cost_cents: costToExVat(formData),
    })
    .eq("id", id);
  query = isAdmin ? query.is("farm_id", null) : query.eq("farm_id", farmId);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  if (!data) redirect("/parts?error=Part+not+found");
  revalidatePath("/parts");
  redirect("/parts?saved=1");
}

export async function deletePart(formData: FormData) {
  const { profile, farmId, isAdmin } = await requireCatalogueManager();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/parts?error=Missing+id");
  const supabase = await createClient();
  let query = supabase
    .from("parts_catalogue")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  query = isAdmin ? query.is("farm_id", null) : query.eq("farm_id", farmId);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  if (!data) redirect("/parts?error=Part+not+found");
  revalidatePath("/parts");
  redirect("/parts?saved=1");
}
