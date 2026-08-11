"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/expenses";

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

  const supplier = s(formData, "supplier_name");
  if (!supplier) redirect("/expenses?error=need-supplier");

  const m = money(formData);
  if (!m) redirect("/expenses?error=need-amount");

  const supabase = await createClient();
  const { error } = await supabase.from("partner_expenses").insert({
    workshop_id: workshop.id,
    supplier_name: supplier,
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
  });

  if (error) redirect(`/expenses?error=${encodeURIComponent(error.message)}`);
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
  const { error } = await supabase
    .from("partner_expenses")
    .update({
      supplier_name: s(formData, "supplier_name") ?? "—",
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
