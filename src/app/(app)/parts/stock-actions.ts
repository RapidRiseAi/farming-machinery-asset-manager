"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { farmPermissionState, requireFarmPermission } from "@/lib/permissions";
import { parseRandsToCents } from "@/lib/money";
import { MOVE_KINDS, type MoveKind } from "@/lib/stock";
import { clampLookahead } from "@/lib/reorder";
import { todayLocal } from "@/lib/format";

/** Log the raw database message for us, and send the person a translated slug. */
function failed(where: string, message: string): never {
  console.error(`[parts] ${where}`, message);
  redirect("/parts?error=save-failed");
}

/**
 * The store (§6 inventory, 0450).
 *
 * Everything goes through the RLS client and the farm comes from the session, never the
 * form, `stock_items`/`stock_movements` are farm-scoped AND farm-side-only, so a
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
  const { profile, farmId } = await requireFarmPermission("manage_stock", "/parts?error=Not+allowed");

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

  // The unique index is the guard against tracking the same part twice, a second attempt
  // is somebody pressing again, not an error worth a red screen.
  if (error && !/duplicate key/i.test(error.message)) failed("trackPart", error.message);
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/** Change where it lives or when to reorder. Never the quantity. */
export async function updateStockItem(formData: FormData) {
  const { farmId } = await requireFarmPermission("manage_stock", "/parts?error=Not+allowed");
  const id = String(formData.get("stock_item_id") ?? "");
  if (!id) redirect("/parts?error=not-found");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stock_items")
    .update({
      unit: s(formData, "unit") ?? "each",
      reorder_point: num(formData, "reorder_point"),
      bin: s(formData, "bin"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("farm_id", farmId)
    .select("id")
    .maybeSingle();

  if (error) failed("updateStockItem", error.message);
  if (!data) redirect("/parts?error=not-found");
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/**
 * Write a movement. This is the only way stock changes.
 *
 * An ADJUSTMENT is the stocktake case and is the one kind whose quantity may be negative
 * in meaning, "I counted two fewer than the system says". The table stores qty positive
 * and lets the kind carry direction, so a shortfall is recorded as an `issue` with a note
 * rather than a negative adjustment; a surplus is an `adjustment`. That keeps every row
 * readable one way only.
 */
export async function recordMovement(formData: FormData) {
  const { profile, farmId } = await requireFarmPermission("manage_stock", "/parts?error=Not+allowed");

  const itemId = String(formData.get("stock_item_id") ?? "");
  const rawKind = String(formData.get("kind") ?? "");
  const kind: MoveKind = (MOVE_KINDS as readonly string[]).includes(rawKind) ? (rawKind as MoveKind) : "receipt";
  const qty = num(formData, "qty");

  if (!itemId) redirect("/parts?error=not-found");
  if (qty == null || qty <= 0) redirect("/parts?error=stock-need-qty");

  const machineId = s(formData, "machine_id");
  const supabase = await createClient();

  const { data: item } = await supabase
    .from("stock_items")
    .select("id")
    .eq("id", itemId)
    .eq("farm_id", farmId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!item) redirect("/parts?error=not-found");

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
    // Today in SAST, not the server's UTC date: a delivery booked at 01:00 is today's.
    occurred_on: s(formData, "occurred_on") ?? todayLocal(),
    note: s(formData, "note"),
    by_user: profile.id,
  });

  if (error) failed("recordMovement", error.message);
  revalidatePath("/parts");
  revalidatePath("/machines");
  redirect("/parts?saved=1#store");
}

/**
 * Book a whole delivery in one go: one receipt per part that has a quantity.
 *
 * The dialog posts every tracked part as `stock_item_id`, with its quantity and unit
 * cost under `qty__<id>` and `unit_cost__<id>`. A blank quantity means "not in this
 * delivery" and is skipped. A quantity that is there but is not a positive number
 * refuses the whole delivery: booking five of six lines and quietly dropping the sixth
 * leaves a count nobody can trust. Every id is checked against this farm in one read,
 * and the receipts go in as one insert, so the 0450 rollup sees all of them or none.
 */
export async function receiveDelivery(formData: FormData) {
  const { profile, farmId } = await requireFarmPermission("manage_stock", "/parts?error=Not+allowed");

  const ids = [...new Set(formData.getAll("stock_item_id").map(String).filter(Boolean))];
  const lines: { id: string; qty: number; unitCost: number | null }[] = [];
  for (const id of ids) {
    if (String(formData.get(`qty__${id}`) ?? "").trim() === "") continue;
    const qty = num(formData, `qty__${id}`);
    if (qty == null || qty <= 0) redirect("/parts?error=stock-need-qty");
    lines.push({ id, qty, unitCost: parseRandsToCents(String(formData.get(`unit_cost__${id}`) ?? "")) });
  }
  if (lines.length === 0) redirect("/parts?error=stock-need-qty");

  const supabase = await createClient();
  const { data: items } = await supabase
    .from("stock_items")
    .select("id")
    .in("id", lines.map((l) => l.id))
    .eq("farm_id", farmId)
    .is("deleted_at", null);
  const known = new Set(((items ?? []) as { id: string }[]).map((i) => i.id));
  if (lines.some((l) => !known.has(l.id))) redirect("/parts?error=not-found");

  const occurredOn = s(formData, "occurred_on") ?? todayLocal();
  const note = s(formData, "note");
  const { error } = await supabase.from("stock_movements").insert(
    lines.map((l) => ({
      farm_id: farmId,
      stock_item_id: l.id,
      kind: "receipt" satisfies MoveKind,
      qty: l.qty,
      unit_cost_cents: l.unitCost,
      machine_id: null,
      job_card_id: null,
      occurred_on: occurredOn,
      note,
      by_user: profile.id,
    })),
  );

  if (error) failed("receiveDelivery", error.message);
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/**
 * Stop holding this part. Soft delete, like everything else, the movements stay, so the
 * history of what was fitted to which machine survives the shelf being cleared.
 */
export async function untrackPart(formData: FormData) {
  const { profile, farmId } = await requireFarmPermission("manage_stock", "/parts?error=Not+allowed");
  const id = String(formData.get("stock_item_id") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stock_items")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id)
    .eq("farm_id", farmId)
    .select("id")
    .maybeSingle();
  if (error) failed("untrackPart", error.message);
  if (!data) redirect("/parts?error=not-found");
  revalidatePath("/parts");
  redirect("/parts?saved=1#store");
}

/**
 * How far ahead the store looks for parts the schedule has already spoken for (0503).
 *
 * 0451 declined to guess a lookahead, on the grounds that it is a judgement better made by
 * somebody who has run a farm store. So it is a farm SETTING, and it is written through the
 * existing `update_farm_settings` RPC (0204), owner/manager guarded inside the function,
 * a jsonb merge, no schema change and no new policy. The clamp is applied here as well as
 * on read so a mistyped 3000 is not quietly stored and then silently ignored.
 *
 * It lives on /parts rather than /settings because this is where the number is read: the
 * card states the window in words, and its "Change" dialog is the control that moves it.
 */
export async function setReorderWindow(formData: FormData) {
  const { farmId, role } = await farmPermissionState();
  if (!farmId || !role || !["owner", "manager"].includes(role)) {
    redirect("/parts?error=Not+allowed");
  }

  const days = clampLookahead(String(formData.get("reorder_lookahead_days") ?? ""));

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_farm_settings", {
    p_farm: farmId,
    // A cleared box means "use the default", which the SQL reads as an absent key. Writing
    // JSON null rather than deleting keeps this a one-line merge.
    p_settings: { reorder_lookahead_days: days },
  });

  if (error) failed("setReorderWindow", error.message);
  revalidatePath("/parts");
  redirect("/parts?saved=1#next");
}
