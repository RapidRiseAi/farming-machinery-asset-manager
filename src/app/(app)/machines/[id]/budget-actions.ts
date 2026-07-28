"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { parseRandsToCents } from "@/lib/money";
import { COST_TYPES } from "@/lib/cost";
import { BUDGET_PERIODS, computePeriodBounds, type BudgetPeriodType } from "@/lib/budgets";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function strOrNull(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function periodType(fd: FormData): BudgetPeriodType {
  const v = String(fd.get("period_type") ?? "month");
  return (BUDGET_PERIODS as readonly string[]).includes(v) ? (v as BudgetPeriodType) : "month";
}
function category(fd: FormData): string | null {
  const v = String(fd.get("category") ?? "").trim();
  return v !== "" && (COST_TYPES as readonly string[]).includes(v) ? v : null;
}
/** The anchor date that selects the period; defaults to today when blank/invalid. */
function anchor(fd: FormData): string {
  const v = String(fd.get("anchor") ?? "").trim();
  return YMD.test(v) ? v : new Date().toISOString().slice(0, 10);
}

/** Set a budget target (ex-VAT) for a machine + optional category + period (FR-10.4). */
export async function addBudget(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const farmId = String(formData.get("farm_id") ?? "");
  const amount = parseRandsToCents(strOrNull(formData, "amount"));
  if (!machineId || !farmId) redirect(`/machines/${machineId}?error=Missing+machine`);
  if (amount == null || amount <= 0) redirect(`/machines/${machineId}?error=Budget+amount+is+required`);

  const pt = periodType(formData);
  const { start, end } = computePeriodBounds(pt, anchor(formData));
  const supabase = await createClient();
  const { error } = await supabase.from("budgets").insert({
    farm_id: farmId,
    machine_id: machineId,
    category: category(formData),
    period_type: pt,
    period_start: start,
    period_end: end,
    amount_cents: amount,
    note: strOrNull(formData, "note"),
  });
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=budget`);
}

/** Edit a budget's amount / category / period. */
export async function updateBudget(formData: FormData) {
  await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  const amount = parseRandsToCents(strOrNull(formData, "amount"));
  if (!id) redirect(`/machines/${machineId}?error=Missing+id`);
  if (amount == null || amount <= 0) redirect(`/machines/${machineId}?error=Budget+amount+is+required`);

  const pt = periodType(formData);
  const { start, end } = computePeriodBounds(pt, anchor(formData));
  const supabase = await createClient();
  const { error } = await supabase
    .from("budgets")
    .update({
      category: category(formData),
      period_type: pt,
      period_start: start,
      period_end: end,
      amount_cents: amount,
      note: strOrNull(formData, "note"),
    })
    .eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=budget`);
}

/** Soft-delete a budget. */
export async function deleteBudget(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const machineId = String(formData.get("machine_id") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!id) redirect(`/machines/${machineId}?error=Missing+id`);
  const supabase = await createClient();
  const { error } = await supabase
    .from("budgets")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(`/machines/${machineId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=budget`);
}
