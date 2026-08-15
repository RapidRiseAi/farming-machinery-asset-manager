"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, currentWorkshop } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";
import { percentToBps } from "@/lib/format";
import { splitInclusive, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/expenses";
import { CADENCES, type Cadence } from "@/lib/recurring-expenses";

/**
 * Standing costs (G19).
 *
 * These rows are workshop-scoped and RLS enforces it, so every write here goes through
 * the ordinary RLS client — never the service role — and a partner cannot touch another
 * workshop's schedules even by guessing an id. The `workshop_id` is taken from the
 * session, never from the form.
 *
 * Money is captured exactly the way `/expenses` captures it, and for the same reason: a
 * standing invoice says "R5 175,00" on it, that is the number a partner reads, so that is
 * the number the form asks for and the split into R4 500 + R675 happens HERE, before
 * anything is stored. The VAT box stays editable because the supplier's own VAT line is
 * what may legally be claimed, and a bill that rounds oddly would otherwise be silently
 * restated twelve times a year instead of once.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

function category(fd: FormData): ExpenseCategory {
  const raw = String(fd.get("category") ?? "other");
  return (EXPENSE_CATEGORIES as readonly string[]).includes(raw) ? (raw as ExpenseCategory) : "other";
}

function cadence(fd: FormData): Cadence {
  const raw = String(fd.get("cadence") ?? "monthly");
  return (CADENCES as readonly string[]).includes(raw) ? (raw as Cadence) : "monthly";
}

const today = () => new Date().toISOString().slice(0, 10);

/** Amount + VAT off the form, however the partner chose to type it. */
function money(fd: FormData): { amount_cents: number; vat_cents: number; vat_rate_bps: number } | null {
  const rateBps = percentToBps(String(fd.get("vat_percent") ?? "15")) ?? 1500;
  const typed = parseRandsToCents(String(fd.get("amount") ?? ""));
  if (typed == null || typed <= 0) return null;

  const inclusive = fd.get("amount_incl_vat") != null;
  const split = inclusive
    ? splitInclusive(typed, rateBps)
    : { exCents: typed, vatCents: Math.round((typed * rateBps) / 10000) };

  // An explicitly typed VAT amount wins over the computed one — that is the whole reason
  // the field is offered.
  const typedVat = parseRandsToCents(String(fd.get("vat_amount") ?? ""));
  return {
    amount_cents: split.exCents,
    vat_cents: rateBps === 0 ? 0 : typedVat != null && typedVat >= 0 ? typedVat : split.vatCents,
    vat_rate_bps: rateBps,
  };
}

export async function createExpenseSchedule(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const name = s(formData, "name");
  if (!name) redirect("/recurring-expenses?error=need-name");
  // Free text, and it stays free text: making a partner file a supplier record before
  // they can record that the rent goes off every month is a filing step in front of the
  // one thing this feature exists to stop them forgetting.
  const supplier = s(formData, "supplier_name");
  if (!supplier) redirect("/recurring-expenses?error=need-supplier");

  const m = money(formData);
  if (!m) redirect("/recurring-expenses?error=need-amount");

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("recurring_expenses")
    .insert({
      workshop_id: workshop.id,
      name,
      supplier_name: supplier,
      supplier_vat_number: s(formData, "supplier_vat_number"),
      reference: s(formData, "reference"),
      description: s(formData, "description"),
      category: category(formData),
      amount_cents: m.amount_cents,
      vat_cents: m.vat_cents,
      vat_rate_bps: m.vat_rate_bps,
      // Unticked means "I cannot claim this back" — entertainment, a passenger car,
      // club fees (VAT Act s17(2)). On a standing charge this is set once and then
      // applies every month, which is exactly why it is worth asking about here.
      vat_claimable: formData.get("vat_claimable") != null,
      cadence: cadence(formData),
      next_due_date: s(formData, "next_due_date") ?? today(),
      ends_on: s(formData, "ends_on"),
      auto_paid: formData.get("auto_paid") != null,
      created_by: profile.id,
    })
    .select("id")
    .single();

  if (error) redirect(`/recurring-expenses?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/recurring-expenses");
  redirect(`/recurring-expenses/${(created as { id: string }).id}?saved=1`);
}

export async function updateExpenseSchedule(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  if (!id) redirect("/recurring-expenses?error=not-found");

  const m = money(formData);
  if (!m) redirect(`/recurring-expenses/${id}?error=need-amount`);

  const supabase = await createClient();
  // No workshop filter on the update: RLS already scopes `recurring_expenses`, so a
  // guessed id from another workshop matches zero rows rather than someone else's books.
  const { error } = await supabase
    .from("recurring_expenses")
    .update({
      name: s(formData, "name") ?? "—",
      supplier_name: s(formData, "supplier_name") ?? "—",
      supplier_vat_number: s(formData, "supplier_vat_number"),
      reference: s(formData, "reference"),
      description: s(formData, "description"),
      category: category(formData),
      amount_cents: m.amount_cents,
      vat_cents: m.vat_cents,
      vat_rate_bps: m.vat_rate_bps,
      vat_claimable: formData.get("vat_claimable") != null,
      cadence: cadence(formData),
      next_due_date: s(formData, "next_due_date") ?? today(),
      ends_on: s(formData, "ends_on"),
      auto_paid: formData.get("auto_paid") != null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/recurring-expenses/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/recurring-expenses/${id}`);
  redirect(`/recurring-expenses/${id}?saved=1`);
}

/**
 * Pause or restart a schedule — the one thing a partner does to one most often.
 *
 * Pausing is the honest answer to "we have stopped paying for this": deleting it would
 * lose the record of what was being paid and when it stopped, and editing the end date
 * requires knowing a date. It changes nothing already captured.
 */
export async function toggleExpenseSchedule(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const active = String(formData.get("active") ?? "") === "1";
  const supabase = await createClient();
  const { error } = await supabase
    .from("recurring_expenses")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) redirect(`/recurring-expenses/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/recurring-expenses");
  redirect(`/recurring-expenses/${id}?saved=1`);
}

/**
 * Capture this schedule's expense now, rather than waiting for the night.
 *
 * `run_recurring_expense` checks ownership itself — the generator underneath is SECURITY
 * DEFINER and would otherwise honour any id handed to it. It is also the same code path
 * the cron uses, including the same "already done this period" guard, so pressing it
 * twice cannot book the same month's rent twice. A return of 0 is therefore a normal
 * answer, not a failure, and the screen says which happened.
 */
export async function runExpenseScheduleNow(formData: FormData) {
  await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("run_recurring_expense", { p_id: id });
  if (error) redirect(`/recurring-expenses/${id}?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/recurring-expenses");
  revalidatePath("/expenses");
  revalidatePath("/money");
  revalidatePath("/vat");
  redirect(`/recurring-expenses/${id}?${Number(data) > 0 ? "captured=1" : "nothing=1"}`);
}

/**
 * Soft delete, like everything else in this schema. Expenses ALREADY captured are left
 * exactly where they are — they are real costs that were really incurred, and removing
 * them would restate a VAT period that may already have been filed. Only the future
 * stops.
 */
export async function deleteExpenseSchedule(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("schedule_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("recurring_expenses")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id, active: false })
    .eq("id", id);
  revalidatePath("/recurring-expenses");
  redirect("/recurring-expenses?deleted=1");
}
