"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { runOnce } from "@/lib/request-claim";
import { readRequestId, REQUEST_FIELD } from "@/lib/request-id";
import { dfyPriceRefusal, isServiceCode, WORK_ACTIVITIES } from "@/lib/service-orders";
import { createServiceClient } from "@/lib/supabase/service";
import { randsToCents } from "@/lib/trips";

/**
 * Rapid Rise offers a Done-For-You agreement or an optional service order, invoices an accepted
 * order, ends an agreement, and records work and reviews (20261120100000).
 *
 * Every action starts with `requireRole(["rr_admin"])` (two-step this session, never a test
 * account). The service role carries the call with the admin's id, which the database checks
 * again (`app.service_rr_actor`). The screen's request id is also the database's idempotency
 * key, so a retried offer or log entry is the same row. Internal and English, like the console.
 */

const back = (farmId: string, query: string) => `/admin/farms/${farmId}?${query}#services`;
const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);
const int = (formData: FormData, name: string): number | null => {
  const raw = text(formData, name, 12);
  return /^\d+$/.test(raw) ? Number(raw) : null;
};
const date = (formData: FormData, name: string): string | null => {
  const raw = text(formData, name, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};
function farmOf(formData: FormData): string {
  const farm = String(formData.get("farm_id") ?? "");
  if (!isUuid(farm)) redirect("/admin/farms?error=admin-farm-invalid");
  return farm;
}
function requestOf(formData: FormData, farmId: string): string {
  const id = readRequestId(formData.get(REQUEST_FIELD));
  if (!id) redirect(back(farmId, "error=still-saving"));
  return id;
}

export async function offerAgreement(formData: FormData) {
  const farmId = farmOf(formData);
  return runOnce(formData, "admin:dfy-offer", async () => {
    const admin = await requireRole(["rr_admin"]);
    const request = requestOf(formData, farmId);
    const period = text(formData, "billing_period", 10) === "annual" ? "annual" : "monthly";
    const prices = {
      period,
      spaceCents: randsToCents(text(formData, "space_price", 20)) ?? Number.NaN,
      minSpaces: int(formData, "min_spaces") ?? Number.NaN,
      equipmentIncluded: int(formData, "equipment_included") ?? Number.NaN,
      equipmentCents: randsToCents(text(formData, "equipment_price", 20)) ?? Number.NaN,
    } as const;
    const refusal = dfyPriceRefusal(prices);
    if (refusal) return back(farmId, `error=${refusal}`);
    const { error } = await createServiceClient().rpc("dfy_offer", {
      p_by: admin.id,
      p_farm: farmId,
      p_request: request,
      p_reference: text(formData, "reference", 100),
      p_period: period,
      p_space_cents: prices.spaceCents,
      p_min_spaces: prices.minSpaces,
      p_equipment_included: prices.equipmentIncluded,
      p_equipment_cents: prices.equipmentCents,
      p_assumed_full: int(formData, "assumed_full") ?? -1,
      p_assumed_equipment: int(formData, "assumed_equipment") ?? -1,
      p_scope: text(formData, "scope", 2000),
      p_work_allowance: text(formData, "work_allowance", 1000),
      p_review_schedule: text(formData, "review_schedule", 500),
      p_staff_owner: text(formData, "staff_owner", 200),
      p_extras: text(formData, "extras", 1000),
      p_assumptions: text(formData, "assumptions", 1000),
      p_supplier_mandate: text(formData, "supplier_mandate", 1000),
      p_term_months: int(formData, "term_months") ?? 0,
      p_effective_from: date(formData, "effective_from"),
      p_expires_on: date(formData, "expires_on"),
    });
    if (error) return back(farmId, `error=${errorCode(error, "admin:dfy-offer", "service-invalid")}`);
    revalidatePath(`/admin/farms/${farmId}`);
    return back(farmId, "saved=1");
  }, { whileRunning: back(farmId, "error=still-saving") });
}

export async function cancelAgreement(formData: FormData) {
  const farmId = farmOf(formData);
  const admin = await requireRole(["rr_admin"]);
  const quote = String(formData.get("quote_id") ?? "");
  if (!isUuid(quote)) redirect(back(farmId, "error=missing-id"));
  const { error } = await createServiceClient().rpc("dfy_cancel", { p_by: admin.id, p_quote: quote, p_reason: text(formData, "reason", 300) });
  if (error) redirect(back(farmId, `error=${errorCode(error, "admin:dfy-cancel", "service-not-open")}`));
  revalidatePath(`/admin/farms/${farmId}`);
  redirect(back(farmId, "saved=1"));
}

export async function endAgreement(formData: FormData) {
  const farmId = farmOf(formData);
  const admin = await requireRole(["rr_admin"]);
  const quote = String(formData.get("quote_id") ?? "");
  const next = text(formData, "next_plan", 20);
  if (!isUuid(quote) || !["essential", "professional", "complete"].includes(next)) redirect(back(farmId, "error=service-invalid"));
  const { error } = await createServiceClient().rpc("dfy_end", {
    p_by: admin.id, p_quote: quote, p_next_plan: next, p_reason: text(formData, "reason", 300),
  });
  if (error) redirect(back(farmId, `error=${errorCode(error, "admin:dfy-end", "service-not-open")}`));
  revalidatePath(`/admin/farms/${farmId}`);
  redirect(back(farmId, "saved=1"));
}

export async function offerOrder(formData: FormData) {
  const farmId = farmOf(formData);
  return runOnce(formData, "admin:service-offer", async () => {
    const admin = await requireRole(["rr_admin"]);
    const request = requestOf(formData, farmId);
    const code = text(formData, "code", 40);
    if (!isServiceCode(code)) return back(farmId, "error=service-not-orderable");
    const quantity = Number(text(formData, "quantity", 12).replace(",", "."));
    const machines = text(formData, "machine_ids", 20000).split(/[\s,]+/).filter(Boolean);
    if (machines.some((m) => !isUuid(m))) return back(farmId, "error=service-invalid");
    const { error } = await createServiceClient().rpc("service_order_offer", {
      p_by: admin.id,
      p_farm: farmId,
      p_request: request,
      p_code: code,
      p_quantity: Number.isFinite(quantity) ? quantity : 0,
      p_quoted: randsToCents(text(formData, "quoted", 20)),
      p_travel: randsToCents(text(formData, "travel", 20)) ?? 0,
      p_scope: text(formData, "scope", 2000),
      p_delivery: text(formData, "delivery", 1000),
      p_assumptions: text(formData, "assumptions", 1000),
      p_work_key: text(formData, "work_key", 100),
      p_machines: machines,
      p_expires_on: date(formData, "expires_on"),
    });
    if (error) return back(farmId, `error=${errorCode(error, "admin:service-offer", "service-invalid")}`);
    revalidatePath(`/admin/farms/${farmId}`);
    return back(farmId, "saved=1");
  }, { whileRunning: back(farmId, "error=still-saving") });
}

export async function invoiceOrder(formData: FormData) {
  const farmId = farmOf(formData);
  return runOnce(formData, "admin:service-invoice", async () => {
    const admin = await requireRole(["rr_admin"]);
    const order = String(formData.get("order_id") ?? "");
    if (!isUuid(order)) return back(farmId, "error=missing-id");
    const { error } = await createServiceClient().rpc("service_order_invoice", {
      p_by: admin.id, p_order: order, p_due: date(formData, "due_on"),
    });
    if (error) return back(farmId, `error=${errorCode(error, "admin:service-invoice", "service-not-accepted")}`);
    revalidatePath(`/admin/farms/${farmId}`);
    return back(farmId, "saved=1");
  }, { whileRunning: back(farmId, "error=still-saving") });
}

export async function closeOrder(formData: FormData) {
  const farmId = farmOf(formData);
  const admin = await requireRole(["rr_admin"]);
  const order = String(formData.get("order_id") ?? "");
  const status = text(formData, "status", 20);
  if (!isUuid(order) || !["completed", "cancelled"].includes(status)) redirect(back(farmId, "error=service-invalid"));
  const { error } = await createServiceClient().rpc("service_order_close", {
    p_by: admin.id, p_order: order, p_status: status, p_reason: text(formData, "reason", 300),
  });
  if (error) redirect(back(farmId, `error=${errorCode(error, "admin:service-close", "service-not-open")}`));
  revalidatePath(`/admin/farms/${farmId}`);
  redirect(back(farmId, "saved=1"));
}

export async function logServiceWork(formData: FormData) {
  const farmId = farmOf(formData);
  return runOnce(formData, "admin:service-log", async () => {
    const admin = await requireRole(["rr_admin"]);
    const request = requestOf(formData, farmId);
    const target = text(formData, "target", 60);
    const [kind, id] = target.split(":");
    if (!["agreement", "order"].includes(kind) || !isUuid(id)) return back(farmId, "error=service-invalid");
    const entry = text(formData, "kind", 10) === "review" ? "review" : "work";
    const activity = text(formData, "activity", 40);
    if (entry === "work" && !(WORK_ACTIVITIES as readonly string[]).includes(activity)) return back(farmId, "error=service-invalid");
    const machine = text(formData, "machine_id", 40);
    const { error } = await createServiceClient().rpc("service_log", {
      p_by: admin.id,
      p_request: request,
      p_quote: kind === "agreement" ? id : null,
      p_order: kind === "order" ? id : null,
      p_kind: entry,
      p_activity: entry === "work" ? activity : null,
      p_machine: isUuid(machine) ? machine : null,
      p_minutes: entry === "work" ? int(formData, "minutes") ?? 0 : 0,
      p_worked_on: date(formData, "worked_on"),
      p_note: text(formData, "note", 4000),
      p_outcome: entry === "review" ? text(formData, "outcome", 4000) : null,
      p_next_review: entry === "review" ? date(formData, "next_review_on") : null,
    });
    if (error) return back(farmId, `error=${errorCode(error, "admin:service-log", "service-invalid")}`);
    revalidatePath(`/admin/farms/${farmId}`);
    return back(farmId, "saved=1");
  }, { whileRunning: back(farmId, "error=still-saving") });
}
