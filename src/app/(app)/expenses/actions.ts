"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/expenses";
import { uploadReceipt } from "@/lib/receipt-media";

/**
 * What the partner bought (G6).
 *
 * These rows are workshop-scoped and RLS enforces it, so every write here goes through
 * the ordinary RLS client and a partner cannot touch another workshop's books even by
 * guessing an id. The `workshop_id` is taken from the session, never from the form.
 *
 * The one judgement in here is how money is captured. A receipt says R1 150,00 including
 * VAT — that is the number a partner reads off the paper, so that is the number the form
 * asks for, and the split into R1 000 + R150 happens here. The VAT is then EDITABLE,
 * because the supplier's own VAT line is what may legally be claimed and a mixed-rate or
 * oddly-rounded invoice would otherwise be silently restated.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

type Db = Awaited<ReturnType<typeof createClient>>;

/**
 * Who this invoice is from, however the form offered it (G18).
 *
 * The form posts EITHER a `supplier_id` picked from the book or a `supplier_name` typed
 * for someone new. Both end up writing the name, because every screen, CSV and PDF in the
 * product prints it and because an expense must stay readable when the supplier record is
 * later deactivated or removed.
 *
 * When an id is picked the name is read back from the record rather than trusted from the
 * form — the two are posted from the same page and could otherwise disagree, at which point
 * the row would print one business and age under another. The lookup goes through the
 * caller's RLS client, so an id belonging to another workshop simply comes back empty and
 * is refused here; the composite foreign key would refuse it again at the insert.
 *
 * Typed text is deliberately left as text. The 0481 trigger attaches it to a record if one
 * of that name already exists, and files nothing if not — a typo must not mint a supplier.
 */
async function resolveSupplier(
  supabase: Db,
  fd: FormData
): Promise<{ supplier_id: string | null; supplier_name: string } | null> {
  const id = s(fd, "supplier_id");
  if (id) {
    const { data } = await supabase.from("suppliers").select("name").eq("id", id).maybeSingle();
    const name = (data as { name: string } | null)?.name;
    return name ? { supplier_id: id, supplier_name: name } : null;
  }
  const typed = s(fd, "supplier_name");
  return typed ? { supplier_id: null, supplier_name: typed } : null;
}

function category(fd: FormData): ExpenseCategory {
  const raw = String(fd.get("category") ?? "other");
  return (EXPENSE_CATEGORIES as readonly string[]).includes(raw) ? (raw as ExpenseCategory) : "other";
}

/** Amount + VAT off the form, however the partner chose to type it. */
function money(fd: FormData): { amount_cents: number; vat_cents: number; vat_rate_bps: number } | null {
  const rateBps = percentToBps(String(fd.get("vat_percent") ?? "15")) ?? 1500;
  const typed = parseRandsToCents(String(fd.get("amount") ?? ""));
  if (typed == null || typed <= 0) return null;

  const inclusive = fd.get("amount_incl_vat") != null;
  const split = inclusive ? splitInclusive(typed, rateBps) : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };

  // An explicitly typed VAT amount wins over the computed one — that is the whole reason
  // the field is offered.
  const typedVat = parseRandsToCents(String(fd.get("vat_amount") ?? ""));
  return {
    amount_cents: split.exCents,
    vat_cents: rateBps === 0 ? 0 : (typedVat != null && typedVat >= 0 ? typedVat : split.vatCents),
    vat_rate_bps: rateBps,
  };
}

export async function createExpense(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const m = money(formData);
  if (!m) redirect("/expenses?error=need-amount");

  const supabase = await createClient();
  const supplier = await resolveSupplier(supabase, formData);
  if (!supplier) redirect("/expenses?error=need-supplier");

  const { data: created, error } = await supabase
    .from("partner_expenses")
    .insert({
      workshop_id: workshop.id,
      // Both are written even when one was derived from the other: the id is what the
      // payables ageing groups by, and the name is what every screen and PDF prints. The
      // 0481 trigger fills the id in for typed text when a record of that name exists.
      supplier_name: supplier.supplier_name,
      supplier_id: supplier.supplier_id,
      supplier_vat_number: s(formData, "supplier_vat_number"),
      reference: s(formData, "reference"),
      category: category(formData),
      description: s(formData, "description"),
      expense_date: s(formData, "expense_date") ?? new Date().toISOString().slice(0, 10),
      paid_on: s(formData, "paid_on"),
      amount_cents: m.amount_cents,
      vat_cents: m.vat_cents,
      vat_rate_bps: m.vat_rate_bps,
      // Unticked means "I cannot claim this back" — entertainment, a passenger car,
      // club fees (VAT Act s17(2)).
      vat_claimable: formData.get("vat_claimable") != null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`/expenses?error=${encodeURIComponent(error.message)}`);

  // A receipt at capture time is optional. If one was chosen and the upload fails, the
  // EXPENSE still stands — losing a captured supplier invoice because a photo did not
  // stick would be the worse outcome, and the row will simply show as unsupported until
  // someone attaches it.
  const file = formData.get("receipt");
  if (file instanceof File && file.size > 0 && created) {
    const up = await uploadReceipt(supabase, file, workshop.id, (created as { id: string }).id);
    if ("path" in up) {
      await supabase.from("partner_expenses").update({ receipt_path: up.path }).eq("id", (created as { id: string }).id);
    } else {
      revalidatePath("/expenses");
      revalidatePath("/vat");
      redirect(`/expenses?saved=1&error=receipt-${up.error}`);
    }
  }

  revalidatePath("/expenses");
  revalidatePath("/vat");
  redirect("/expenses?saved=1");
}

/**
 * Attach the supplier's tax invoice to an expense already captured.
 *
 * Separate from create/update on purpose: capture happens on a phone in a yard and the
 * paper turns up afterwards, so attaching later is the NORMAL case rather than a repair.
 * Nothing here blocks a claim without proof — the row and the VAT return say so instead
 * (see `claimNeedsProof`).
 *
 * The upload uses the RLS client, so the 0430 storage policies decide whether this
 * partner may write to this folder; and the row update is `.eq("id", …)` with no
 * workshop filter because RLS already scopes `partner_expenses` — a guessed id from
 * another workshop matches zero rows rather than someone else's receipt.
 */
export async function attachReceipt(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const id = String(formData.get("expense_id") ?? "");
  if (!id) redirect("/expenses?error=not-found");

  const supabase = await createClient();
  const result = await uploadReceipt(supabase, formData.get("receipt"), workshop.id, id);
  if ("error" in result) redirect(`/expenses?error=receipt-${result.error}`);

  const { error } = await supabase
    .from("partner_expenses")
    .update({ receipt_path: result.path, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) redirect(`/expenses?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/expenses");
  revalidatePath("/vat");
  redirect("/expenses?attached=1");
}

/**
 * Detach a receipt — the wrong photo, or one belonging to another invoice.
 *
 * The stored object is deliberately left behind for the storage sweep rather than deleted
 * here: a failed delete must not stop the row being corrected, and an orphaned private
 * object is harmless where a row pointing at the wrong document is not.
 */
export async function removeReceipt(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("expense_id") ?? "");
  if (!id) redirect("/expenses?error=not-found");

  const supabase = await createClient();
  await supabase
    .from("partner_expenses")
    .update({ receipt_path: null, updated_at: new Date().toISOString() })
    .eq("id", id);

  revalidatePath("/expenses");
  revalidatePath("/vat");
  redirect("/expenses?saved=1");
}

export async function updateExpense(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("expense_id") ?? "");
  if (!id) redirect("/expenses?error=not-found");

  const m = money(formData);
  if (!m) redirect(`/expenses?error=need-amount`);

  const supabase = await createClient();
  // A correction must still name somebody. The old fallback wrote "—" when the field came
  // back empty, which put a nameless creditor onto the payables ageing for ever — the exact
  // phantom this feature exists to end — so an empty supplier is now refused instead.
  const supplier = await resolveSupplier(supabase, formData);
  if (!supplier) redirect("/expenses?error=need-supplier");

  const { error } = await supabase
    .from("partner_expenses")
    .update({
      supplier_name: supplier.supplier_name,
      // Set explicitly so switching an invoice from one record to another sticks. Writing
      // the id here also stops the 0481 trigger's "the name was edited, drop the link"
      // rule from firing on a deliberate re-pick, because the id changed too.
      supplier_id: supplier.supplier_id,
      supplier_vat_number: s(formData, "supplier_vat_number"),
      reference: s(formData, "reference"),
      category: category(formData),
      description: s(formData, "description"),
      expense_date: s(formData, "expense_date") ?? new Date().toISOString().slice(0, 10),
      paid_on: s(formData, "paid_on"),
      amount_cents: m.amount_cents,
      vat_cents: m.vat_cents,
      vat_rate_bps: m.vat_rate_bps,
      vat_claimable: formData.get("vat_claimable") != null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/expenses?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/expenses");
  revalidatePath("/vat");
  redirect("/expenses?saved=1");
}

/**
 * Mark a supplier invoice as settled. Separate from the edit form because it is the one
 * thing a partner does to an expense afterwards, and it should not require reopening
 * every field to do it.
 */
export async function markExpensePaid(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("expense_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("partner_expenses")
    .update({ paid_on: s(formData, "paid_on") ?? new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/expenses");
  redirect("/expenses?saved=1");
}

/**
 * Soft delete, like everything else in this schema — the audit trigger keeps the row and
 * the VAT return simply stops seeing it. A deleted expense in a period that has already
 * been FILED will change that period's figures, which is why the screen says so.
 */
export async function deleteExpense(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("expense_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("partner_expenses")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  revalidatePath("/expenses");
  revalidatePath("/vat");
  redirect("/expenses?deleted=1");
}
