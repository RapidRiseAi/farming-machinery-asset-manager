"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentFarmId } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";
import { MOVE_KINDS, type MoveKind } from "@/lib/stock";
import { clampLookahead } from "@/lib/reorder";

/**
 * The store (§6 inventory, 0450).
 *
 * Everything goes through the RLS client and the farm comes from the session, never the
 * form — `stock_items`/`stock_movements` are farm-scoped AND farm-side-only, so a
 * contractor with an active link to this farm gets zero rows rather than a smaller set.
 *
 * `on_hand` is never written here. Stock changes ONLY by writing a movement and letting
 * the 0450 rollup trigger recompute the total, which is what makes two people issuing the
 * same filter at the same moment safe.
 */

function num(fd: FormData, k: string): number | null {
  const raw = String(fd.get(k) ?? "").trim().replace(",", ".");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

/** Start counting a catalogue part. The row IS the decision to hold it in the store. */
export async function trackPart(formData: FormData) {
  const profile = await requireRole(["owner", "manager", "mechanic"]);
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect("/parts?error=no-farm");

  const partId = String(formData.get("part_catalogue_id") ?? "");
  if (!partId) redirect("/parts?error=not-found");

  const supabase = await createClient();
  const { error } = await supabase.from("stock_items").insert({
    farm_id: farmId,
    part_catalogue_id: partId,
    unit: s(formData, "unit") ?? "each",
    reorder_point: num(formData, "reorder_point"),
    bin: s(formData, "bin"),
    created_by: profile.id,
  });

  // The unique index is the guard against tracking the same part twice — a second attempt
  // is somebody pressing again, not an error worth a red screen.
  if (error && !/duplicate key/i.test(error.message)) {
    redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  }
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/** Change where it lives or when to reorder. Never the quantity. */
export async function updateStockItem(formData: FormData) {
  await requireRole(["owner", "manager", "mechanic"]);
  const id = String(formData.get("stock_item_id") ?? "");
  if (!id) redirect("/parts?error=not-found");

  const supabase = await createClient();
  const { error } = await supabase
    .from("stock_items")
    .update({
      unit: s(formData, "unit") ?? "each",
      reorder_point: num(formData, "reorder_point"),
      bin: s(formData, "bin"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/**
 * Write a movement. This is the only way stock changes.
 *
 * An ADJUSTMENT is the stocktake case and is the one kind whose quantity may be negative
 * in meaning — "I counted two fewer than the system says". The table stores qty positive
 * and lets the kind carry direction, so a shortfall is recorded as an `issue` with a note
 * rather than a negative adjustment; a surplus is an `adjustment`. That keeps every row
 * readable one way only.
 */
export async function recordMovement(formData: FormData) {
  const profile = await requireRole(["owner", "manager", "mechanic"]);
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect("/parts?error=no-farm");

  const itemId = String(formData.get("stock_item_id") ?? "");
  const rawKind = String(formData.get("kind") ?? "");
  const kind: MoveKind = (MOVE_KINDS as readonly string[]).includes(rawKind) ? (rawKind as MoveKind) : "receipt";
  const qty = num(formData, "qty");

  if (!itemId) redirect("/parts?error=not-found");
  if (qty == null || qty <= 0) redirect("/parts?error=stock-need-qty");

  const machineId = s(formData, "machine_id");
  const supabase = await createClient();

  const { error } = await supabase.from("stock_movements").insert({
    farm_id: farmId,
    stock_item_id: itemId,
    kind,
    qty,
    unit_cost_cents: parseRandsToCents(String(formData.get("unit_cost") ?? "")),
    // Only an issue or a return is about a machine. Carrying a machine on a receipt would
    // read as "this arrived for the tractor", which is a different claim than it looks.
    machine_id: kind === "issue" || kind === "return" ? machineId : null,
    job_card_id: kind === "issue" ? s(formData, "job_card_id") : null,
    occurred_on: s(formData, "occurred_on") ?? new Date().toISOString().slice(0, 10),
    note: s(formData, "note"),
    by_user: profile.id,
  });

  if (error) redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/parts");
  revalidatePath("/machines");
  redirect("/parts?saved=1#store");
}

/**
 * Stop holding this part. Soft delete, like everything else — the movements stay, so the
 * history of what was fitted to which machine survives the shelf being cleared.
 */
export async function untrackPart(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = String(formData.get("stock_item_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("stock_items")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/**
 * How far ahead the store looks for parts the schedule has already spoken for (0503).
 *
 * 0451 declined to guess a lookahead, on the grounds that it is a judgement better made by
 * somebody who has run a farm store. So it is a farm SETTING, and it is written through the
 * existing `update_farm_settings` RPC (0204) — owner/manager guarded inside the function,
 * a jsonb merge, no schema change and no new policy. The clamp is applied here as well as
 * on read so a mistyped 3000 is not quietly stored and then silently ignored.
 *
 * It lives on /parts rather than /settings because this is where the number is read: the
 * card states the window in words directly above the control that changes it.
 */
export async function setReorderWindow(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect("/parts?error=no-farm");

  const days = clampLookahead(String(formData.get("reorder_lookahead_days") ?? ""));

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_farm_settings", {
    p_farm: farmId,
    // A cleared box means "use the default", which the SQL reads as an absent key. Writing
    // JSON null rather than deleting keeps this a one-line merge.
    p_settings: { reorder_lookahead_days: days },
  });

  if (error) redirect(`/parts?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/parts");
  redirect("/parts?saved=1#next");
}
