"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import type { AiResult } from "@/lib/ai-usage/results";

/**
 * Rapid Rise's own AI and voice controls (docs/AI_USAGE.md): the margin on provider cost,
 * a manual exchange rate, and the health events the nightly job raises (a price or rate it
 * held back for a person to confirm, a provider failing, credit running low).
 *
 * Platform admins only, re-checked here. Every write uses the service role; the margin
 * lives on the audited billing_settings row, so changing it leaves an audit entry.
 */

function done(code: AiResult): never {
  revalidatePath("/admin/ai");
  redirect(`/admin/ai?ai=${code}`);
}

async function requireRrAdmin(): Promise<string> {
  const profile = await requireProfile();
  if (profile.role !== "rr_admin") done("forbidden");
  return profile.id;
}

export async function setAiMargin(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const percent = Number(String(formData.get("percent") ?? "").replace(",", "."));
  if (!Number.isFinite(percent) || percent < 0 || percent > 500) done("admin-invalid");
  const { error } = await createServiceClient()
    .from("billing_settings")
    .update({ ai_margin_bps: Math.round(percent * 100) })
    .eq("singleton", true);
  if (error) done("failed");
  done("margin-saved");
}

/**
 * When farms start paying for AI and voice use on their invoice (20261010090000), and the
 * smallest AI-only invoice. An empty date stops billing. A date in the past is refused:
 * the ledger already holds use from before it, and billing that would be charging farms
 * for months nobody told them would be charged.
 */
export async function setAiInvoicing(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const startsRaw = String(formData.get("starts") ?? "").trim();
  const minimum = Number(String(formData.get("minimum") ?? "").replace(",", "."));
  if (startsRaw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(startsRaw)) done("admin-invalid");
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100_000) done("admin-invalid");
  const service = createServiceClient();
  const { data: current } = await service.from("billing_settings").select("ai_billing_starts_on").eq("singleton", true).maybeSingle();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
  // The date already in force may stay (billing is live and only the minimum is changing);
  // a new one may not reach back.
  if (startsRaw !== "" && startsRaw < today && startsRaw !== current?.ai_billing_starts_on) done("invoicing-past");
  const { error } = await service
    .from("billing_settings")
    .update({ ai_billing_starts_on: startsRaw === "" ? null : startsRaw, ai_min_invoice_cents: Math.round(minimum * 100) })
    .eq("singleton", true);
  if (error) done("failed");
  done("invoicing-saved");
}

export async function setManualFxRate(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const rate = Number(String(formData.get("rate") ?? "").replace(",", "."));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000) done("admin-invalid");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
  const service = createServiceClient();
  const { error } = await service
    .from("fx_rates")
    .upsert({ day, usd_zar: rate.toFixed(4), source: "manual", fetched_at: new Date().toISOString() }, { onConflict: "day" });
  if (error) done("failed");
  await service.from("ai_health_events").update({ resolved_at: new Date().toISOString() }).eq("kind", "fx_stale").is("resolved_at", null);
  done("fx-saved");
}

export async function resolveAiHealthEvent(formData: FormData): Promise<void> {
  await requireRrAdmin();
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) done("admin-invalid");
  const { error } = await createServiceClient().from("ai_health_events").update({ resolved_at: new Date().toISOString() }).eq("id", id);
  if (error) done("failed");
  done("event-resolved");
}

/** Takes a price the nightly job held back because it moved too far, after a person looked. */
export async function acceptHeldPrice(formData: FormData): Promise<void> {
  const adminId = await requireRrAdmin();
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) done("admin-invalid");
  const service = createServiceClient();
  const { data: event } = await service
    .from("ai_health_events")
    .select("kind, subject, detail")
    .eq("id", id)
    .is("resolved_at", null)
    .maybeSingle();
  const [model, unit] = String(event?.subject ?? "").split(" ");
  const proposed = Number((event?.detail as { proposed?: unknown } | null)?.proposed);
  if (event?.kind !== "price_pending" || !model || !unit || !(proposed > 0)) done("admin-invalid");
  const { error } = await service
    .from("ai_prices")
    .insert({ model, unit, usd_per_unit: proposed, source: "manual", confirmed_by: adminId });
  if (error) done("failed");
  await service.from("ai_health_events").update({ resolved_at: new Date().toISOString() }).eq("id", id);
  done("price-accepted");
}
