"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";

/**
 * Set one machine's book-value policy.
 *
 * == Why this writes through an RPC and not through the table =================
 * The columns it sets live on `machines` beside `purchase_price_cents`, which
 * 20260903074350 withheld from `authenticated` at the COLUMN level. Granting UPDATE here
 * would hand every signed-in user a write on that row. `public.set_machine_depreciation`
 * is SECURITY DEFINER and checks the farm AND the role itself, `has_farm_access` alone
 * would let a linked workshop set a customer's policy, so this action carries no
 * authority of its own beyond being signed in.
 *
 * == Blank means blank ========================================================
 * Switching to a different method clears the other method's input rather than leaving a
 * rate on the row that no longer applies. The RPC does that, deliberately, so it is true
 * however the policy is set and not only when it is set from this screen.
 */

const METHODS = ["none", "straight_line", "reducing_balance"] as const;

function bounce(code: string): never {
  redirect(`/reports/assets?error=${encodeURIComponent(code)}`);
}

export async function setDepreciationPolicy(formData: FormData): Promise<void> {
  await requireProfile();

  const machineId = String(formData.get("machine_id") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(machineId)) bounce("depreciation-missing");

  const method = String(formData.get("method") ?? "").trim();
  if (!(METHODS as readonly string[]).includes(method)) bounce("depreciation-bad-method");

  // Percent on screen, basis points in the database, the farm says "20%", the engine
  // stores 2000, and neither has to know about the other.
  let rateBps: number | null = null;
  if (method === "reducing_balance") {
    const n = Number(String(formData.get("rate") ?? "").trim().replace(",", "."));
    if (!Number.isFinite(n) || n <= 0 || n > 100) bounce("depreciation-bad-rate");
    rateBps = Math.round(n * 100);
    if (rateBps < 1) bounce("depreciation-bad-rate");
  }

  let lifeMonths: number | null = null;
  if (method === "straight_line") {
    // Asked for in YEARS, because that is how a policy is written down and said out loud.
    const n = Number(String(formData.get("years") ?? "").trim().replace(",", "."));
    if (!Number.isFinite(n) || n <= 0 || n > 100) bounce("depreciation-bad-life");
    lifeMonths = Math.round(n * 12);
    if (lifeMonths < 1) bounce("depreciation-bad-life");
  }

  let residualCents: number | null = null;
  const residualRaw = String(formData.get("residual") ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (residualRaw !== "" && method !== "none") {
    const n = Number(residualRaw);
    if (!Number.isFinite(n) || n < 0) bounce("depreciation-bad-residual");
    residualCents = Math.round(n * 100);
  }

  let start: string | null = null;
  const startRaw = String(formData.get("start") ?? "").trim();
  if (startRaw !== "" && method !== "none") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) bounce("depreciation-bad-date");
    start = startRaw;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_machine_depreciation", {
    p_machine: machineId,
    p_method: method,
    p_rate_bps: rateBps,
    p_life_months: lifeMonths,
    p_residual_cents: residualCents,
    p_start: start,
  });
  if (error) {
    // The RPC raises 42501 for "not your farm, or not your role". Told apart from a save
    // failure because the two need different sentences: one is "ask the owner", the other
    // is "try again".
    bounce(error.code === "42501" ? "forbidden" : "depreciation-save-failed");
  }

  revalidatePath("/reports/assets");
  redirect("/reports/assets?saved=1");
}
