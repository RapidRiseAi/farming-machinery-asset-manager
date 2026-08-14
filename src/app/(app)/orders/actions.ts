"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop } from "@/lib/auth";
import { parseRandsToCents, exVatCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/expenses";
import {
  parseQty,
  isPurchaseOrderStatus,
  canConvert,
  receivedSummary,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders";

/**
 * Purchase orders (G16).
 *
 * Every write goes through the ordinary RLS client. These rows are workshop-scoped and
 * 0473's policies enforce it, so a partner cannot touch another workshop's order book even
 * by guessing an id — updates are `.eq("id", …)` with no workshop filter because a guessed
 * id from another workshop matches zero rows rather than somebody else's order. The
 * `workshop_id` on an insert comes from the session and never from the form.
 *
 * Nothing in this file writes to `cost_entries`, and only `convertOrder` writes to
 * `partner_expenses`. That is the whole money rule: an order is a commitment, and the cost
 * appears once, when the supplier's invoice is captured.
 */

const HOME = "/orders";

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

function orderPath(id: string, query = ""): string {
  return `${HOME}/${id}${query}`;
}

/** Refresh every screen an order can be seen from. */
function refresh(id?: string) {
  revalidatePath(HOME);
  if (id) revalidatePath(orderPath(id));
}

/**
 * The VAT rate a line's price should be read against — the ORDER's, read from the
 * database rather than carried in a hidden field. A hidden field would let a form left
 * open while somebody else changed the rate quietly restate the price.
 */
async function orderRate(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orderId: string,
): Promise<number | null> {
  const { data } = await supabase
    .from("purchase_orders")
    .select("vat_rate_bps")
    .eq("id", orderId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { vat_rate_bps: number } | null)?.vat_rate_bps ?? null;
}

/**
 * A unit price off the form. Suppliers quote both ways — a trade counter quotes ex-VAT and
 * a till slip is inclusive — so the form asks which one was typed and the conversion
 * happens here. Ex-VAT integer cents is what gets stored, always.
 */
function unitPrice(fd: FormData, rateBps: number): number {
  const typed = parseRandsToCents(String(fd.get("unit_price") ?? "")) ?? 0;
  if (typed <= 0) return 0;
  return fd.get("price_incl_vat") != null ? exVatCents(typed, rateBps) : typed;
}

// ── The order itself ─────────────────────────────────────────────────────────

export async function createOrder(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supplier = s(formData, "supplier_name");
  if (!supplier) redirect(`${HOME}?error=po-needSupplier`);

  const rate = percentToBps(String(formData.get("vat_percent") ?? "15")) ?? 1500;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("purchase_orders")
    .insert({
      workshop_id: workshop.id,
      supplier_name: supplier,
      reference: s(formData, "reference"),
      order_date: s(formData, "order_date") ?? new Date().toISOString().slice(0, 10),
      expected_date: s(formData, "expected_date"),
      notes: s(formData, "notes"),
      vat_rate_bps: rate,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error || !data) redirect(`${HOME}?error=${encodeURIComponent(error?.message ?? "po-failed")}`);

  refresh();
  // Straight to the order, because an order with no lines on it is not yet an order —
  // the next thing to do is say what is being bought.
  redirect(orderPath((data as { id: string }).id, "?created=1"));
}

export async function updateOrder(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("order_id") ?? "");
  if (!id) redirect(`${HOME}?error=po-notFound`);

  const supplier = s(formData, "supplier_name");
  if (!supplier) redirect(orderPath(id, "?error=po-needSupplier"));

  const supabase = await createClient();
  const { error } = await supabase
    .from("purchase_orders")
    .update({
      supplier_name: supplier,
      reference: s(formData, "reference"),
      order_date: s(formData, "order_date") ?? new Date().toISOString().slice(0, 10),
      expected_date: s(formData, "expected_date"),
      notes: s(formData, "notes"),
      vat_rate_bps: percentToBps(String(formData.get("vat_percent") ?? "15")) ?? 1500,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(orderPath(id, `?error=${encodeURIComponent(error.message)}`));
  refresh(id);
  redirect(orderPath(id, "?saved=1"));
}

/**
 * Move an order along its lifecycle by hand — send it, close it, cancel it.
 *
 * Only the three states a PERSON decides are accepted here. `sent`, `part_received` and
 * `received` belong to the 0474 engine, which derives them from what has actually
 * arrived; letting this action post one of them would put a typed status back in the
 * product through the side door. (The database would correct it anyway — that is what the
 * BEFORE trigger is for — but an action that silently does nothing is worse than one that
 * refuses.)
 */
export async function setOrderStatus(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("order_id") ?? "");
  const raw = String(formData.get("status") ?? "");
  const allowed: PurchaseOrderStatus[] = ["draft", "sent", "closed", "cancelled"];
  if (!id || !isPurchaseOrderStatus(raw) || !allowed.includes(raw)) {
    redirect(id ? orderPath(id, "?error=po-badStatus") : `${HOME}?error=po-notFound`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("purchase_orders")
    .update({ status: raw, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) redirect(orderPath(id, `?error=${encodeURIComponent(error.message)}`));
  refresh(id);
  redirect(orderPath(id, "?saved=1"));
}

/**
 * Soft delete, like everything else in this schema — the audit trigger keeps the row.
 *
 * Refused once the supplier's invoice has been captured against it: the expense points at
 * this order, and hiding the order would leave a cost on the books whose origin cannot be
 * opened. Cancelling is the right move for an order that is not going to happen, and it
 * keeps the record of what was nearly committed.
 */
export async function deleteOrder(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("order_id") ?? "");
  if (!id) redirect(`${HOME}?error=po-notFound`);

  const supabase = await createClient();
  const { count } = await supabase
    .from("partner_expenses")
    .select("id", { count: "exact", head: true })
    .eq("purchase_order_id", id)
    .is("deleted_at", null);
  if ((count ?? 0) > 0) redirect(orderPath(id, "?error=po-hasExpense"));

  const { error } = await supabase
    .from("purchase_orders")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);

  if (error) redirect(orderPath(id, `?error=${encodeURIComponent(error.message)}`));
  refresh(id);
  redirect(`${HOME}?deleted=1`);
}

// ── What is being bought ─────────────────────────────────────────────────────

export async function addLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const id = String(formData.get("order_id") ?? "");
  const description = s(formData, "description");
  const quantity = parseQty(String(formData.get("qty_ordered") ?? ""));
  if (!id) redirect(`${HOME}?error=po-notFound`);
  if (!description) redirect(orderPath(id, "?error=po-needDescription"));
  if (quantity == null || quantity <= 0) redirect(orderPath(id, "?error=po-needQty"));

  const supabase = await createClient();
  const rate = await orderRate(supabase, id);
  if (rate == null) redirect(`${HOME}?error=po-notFound`);

  // Appended, not inserted: the order should read in the sequence it was written.
  const { data: last } = await supabase
    .from("purchase_order_lines")
    .select("sort_order")
    .eq("purchase_order_id", id)
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("purchase_order_lines").insert({
    workshop_id: workshop.id,
    purchase_order_id: id,
    sort_order: ((last as { sort_order: number } | null)?.sort_order ?? 0) + 1,
    description,
    part_no: s(formData, "part_no"),
    qty_ordered: quantity,
    unit_price_cents: unitPrice(formData, rate),
  });

  if (error) redirect(orderPath(id, `?error=${encodeURIComponent(error.message)}`));
  refresh(id);
  redirect(orderPath(id, "?added=1"));
}

/**
 * One save for a line, covering both "the price was wrong" and "two of them arrived".
 *
 * Deliberately one action rather than an edit and a separate receive: on the floor those
 * are the same moment — the box is open, the delivery note is in the other hand, and the
 * price on it is not always the price that was agreed.
 */
export async function saveLine(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("order_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!id || !lineId) redirect(`${HOME}?error=po-notFound`);

  const description = s(formData, "description");
  const quantity = parseQty(String(formData.get("qty_ordered") ?? ""));
  if (!description) redirect(orderPath(id, "?error=po-needDescription"));
  if (quantity == null || quantity <= 0) redirect(orderPath(id, "?error=po-needQty"));

  // Blank means "none yet", not "unchanged" — the field is always rendered with its
  // current value in it, so an empty box is somebody clearing it on purpose.
  const received = parseQty(String(formData.get("qty_received") ?? "")) ?? 0;

  const supabase = await createClient();
  const rate = await orderRate(supabase, id);
  if (rate == null) redirect(`${HOME}?error=po-notFound`);

  const { error } = await supabase
    .from("purchase_order_lines")
    .update({
      description,
      part_no: s(formData, "part_no"),
      qty_ordered: quantity,
      qty_received: received,
      unit_price_cents: unitPrice(formData, rate),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lineId);

  if (error) redirect(orderPath(id, `?error=${encodeURIComponent(error.message)}`));
  refresh(id);
  redirect(orderPath(id, "?saved=1"));
}

export async function removeLine(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("order_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!id || !lineId) redirect(`${HOME}?error=po-notFound`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("purchase_order_lines")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", lineId);

  if (error) redirect(orderPath(id, `?error=${encodeURIComponent(error.message)}`));
  refresh(id);
  redirect(orderPath(id, "?saved=1"));
}

/**
 * The whole delivery arrived. One press instead of typing the same number into every row,
 * which is the common case and the one most likely to be skipped if it is tedious — and a
 * receiving record nobody keeps is the reason this feature exists.
 *
 * Each line is set to exactly what was ordered rather than to some larger figure, so this
 * can never invent an over-delivery.
 */
export async function receiveAll(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("order_id") ?? "");
  if (!id) redirect(`${HOME}?error=po-notFound`);

  const supabase = await createClient();
  const { data } = await supabase
    .from("purchase_order_lines")
    .select("id, qty_ordered")
    .eq("purchase_order_id", id)
    .is("deleted_at", null);

  const lines = (data ?? []) as { id: string; qty_ordered: number }[];
  const now = new Date().toISOString();
  for (const line of lines) {
    await supabase
      .from("purchase_order_lines")
      .update({ qty_received: line.qty_ordered, updated_at: now })
      .eq("id", line.id);
  }

  refresh(id);
  redirect(orderPath(id, "?received=1"));
}

// ── The invoice arrives ──────────────────────────────────────────────────────

/**
 * Turn the order into the one thing that actually costs money: a `partner_expenses` row.
 *
 * The expense is the same row it would have been if no order had ever existed — same VAT
 * treatment, same time of supply, same behaviour on the VAT return and the P&L. It simply
 * remembers which order it settles.
 *
 * The figures are PREFILLED from the order and then editable, because the order is what we
 * asked for and the invoice is what we are being charged. A price rise between ordering
 * and delivery is ordinary, and silently storing the ordered amount would make the books
 * disagree with the paper.
 *
 * Converting twice is refused by a unique index in the database (0475), not by a check
 * here: a double-submitted form and two people capturing the same invoice are the same
 * race, and a read-then-write in this function would lose it.
 */
export async function convertOrder(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const id = String(formData.get("order_id") ?? "");
  if (!id) redirect(`${HOME}?error=po-notFound`);

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select("id, supplier_name, status, vat_rate_bps")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const po = order as { supplier_name: string; status: PurchaseOrderStatus; vat_rate_bps: number } | null;
  if (!po) redirect(`${HOME}?error=po-notFound`);
  if (!canConvert(po.status)) redirect(orderPath(id, "?error=po-cannotConvert"));

  const rateBps = percentToBps(String(formData.get("vat_percent") ?? "15")) ?? po.vat_rate_bps;
  const typed = parseRandsToCents(String(formData.get("amount") ?? ""));
  if (typed == null || typed <= 0) redirect(orderPath(id, "?error=po-needAmount"));

  const inclusive = formData.get("amount_incl_vat") != null;
  const split = inclusive
    ? splitInclusive(typed, rateBps)
    : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };
  // An explicitly typed VAT amount wins over the computed one, exactly as on the expenses
  // screen: the supplier's own VAT line is what may legally be claimed.
  const typedVat = parseRandsToCents(String(formData.get("vat_amount") ?? ""));

  const rawCategory = String(formData.get("category") ?? "parts");
  const category: ExpenseCategory = (EXPENSE_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as ExpenseCategory)
    : "parts";

  const { error } = await supabase.from("partner_expenses").insert({
    workshop_id: workshop.id,
    purchase_order_id: id,
    supplier_name: s(formData, "supplier_name") ?? po.supplier_name,
    supplier_vat_number: s(formData, "supplier_vat_number"),
    reference: s(formData, "reference"),
    category,
    description: s(formData, "description"),
    expense_date: s(formData, "expense_date") ?? new Date().toISOString().slice(0, 10),
    paid_on: s(formData, "paid_on"),
    amount_cents: split.exCents,
    vat_cents: rateBps === 0 ? 0 : typedVat != null && typedVat >= 0 ? typedVat : split.vatCents,
    vat_rate_bps: rateBps,
    vat_claimable: formData.get("vat_claimable") != null,
    created_by: profile.id,
  });

  if (error) {
    // 23505 is the 0475 unique index doing its job. Said in words, because "duplicate key
    // value violates unique constraint" tells a workshop nothing about what happened.
    const code = (error as { code?: string }).code === "23505" ? "po-alreadyConverted" : encodeURIComponent(error.message);
    redirect(orderPath(id, `?error=${code}`));
  }

  // Closing is only right when there is nothing left to come. A supplier who invoices what
  // they have shipped and sends the rest next week leaves an order that is still open, and
  // closing it here would hide the outstanding items — which is the exact record this
  // feature exists to keep.
  const { data: lineRows } = await supabase
    .from("purchase_order_lines")
    .select("qty_ordered, qty_received")
    .eq("purchase_order_id", id)
    .is("deleted_at", null);
  const summary = receivedSummary((lineRows ?? []) as { qty_ordered: number; qty_received: number }[]);
  if (summary.complete) {
    await supabase
      .from("purchase_orders")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("id", id);
  }

  refresh(id);
  revalidatePath("/expenses");
  revalidatePath("/vat");
  redirect(orderPath(id, "?converted=1"));
}
