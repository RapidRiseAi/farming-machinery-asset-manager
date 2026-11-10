"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { BILLING_RPC } from "@/lib/billing/service";
import { isUuid } from "@/lib/ids";
import { runOnce } from "@/lib/request-claim";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { randsToCents } from "@/lib/trips";
import { monthStart, usageCharge, type UsageRates } from "@/lib/usage-billing";

const HERE = "/admin/usage";

/** What Rapid Rise pays for each, and its markup. Through the admin's own client. */
export async function saveUsageRates(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const cents = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    return raw === "" ? null : randsToCents(raw);
  };
  const markup = Number(String(formData.get("markup_percent") ?? "30").trim());
  if (!Number.isFinite(markup) || markup < 0 || markup > 200) redirect(`${HERE}?error=usage-bad`);

  const supabase = await createClient();
  const { error } = await supabase
    .from("usage_rates")
    .update({
      whatsapp_message_cents: cents("whatsapp_message"),
      storage_gb_month_cents: cents("storage_gb_month"),
      markup_bps: Math.round(markup * 100),
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("singleton", true);
  if (error) redirect(`${HERE}?error=${errorCode(error, "app/admin/usage:rates", "usage-bad")}`);
  revalidatePath(HERE);
  redirect(`${HERE}?saved=1`);
}

/**
 * Raise a usage invoice for one business and month, worked out again here rather than taken
 * from the page, through the same once-off service invoice as any other charge.
 */
export async function raiseUsageInvoice(formData: FormData) {
  const profile = await requireRole(["rr_admin"]);
  const farmId = String(formData.get("farm_id") ?? "");
  const month = monthStart(String(formData.get("month") ?? ""));
  if (!isUuid(farmId)) redirect(`${HERE}?error=usage-bad`);

  const svc = createServiceClient();
  return runOnce(
    formData,
    "admin-usage:invoice",
    async () => {
      const [{ data: usage, error: usageError }, { data: rates, error: ratesError }] = await Promise.all([
        svc.rpc("usage_for_month", { p_month: month }),
        svc.from("usage_rates").select("whatsapp_message_cents, storage_gb_month_cents, markup_bps").maybeSingle(),
      ]);
      if (usageError || ratesError || !rates) redirect(`${HERE}?month=${month.slice(0, 7)}&error=usage-bad`);
      const row = ((usage ?? []) as { farm_id: string; whatsapp_sent: number; storage_bytes: number }[]).find((u) => u.farm_id === farmId);
      if (!row) redirect(`${HERE}?month=${month.slice(0, 7)}&error=usage-nothing`);
      const charge = usageCharge(row, rates as UsageRates);
      const label = month.slice(0, 7);
      const lines = [
        charge.whatsappCents > 0
          ? { code: "whatsapp", description: `WhatsApp messages, ${label}: ${row.whatsapp_sent} sent`, qty: 1, unit_price_cents: charge.whatsappCents }
          : null,
        charge.storageCents > 0
          ? { code: "storage", description: `File storage, ${label}: ${charge.gigabytes} GB`, qty: 1, unit_price_cents: charge.storageCents }
          : null,
      ].filter(Boolean);
      if (lines.length === 0) redirect(`${HERE}?month=${label}&error=usage-nothing`);

      const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { error } = await svc.rpc(BILLING_RPC.raiseServiceInvoice, {
        p_farm: farmId,
        p_lines: lines,
        p_due_on: due,
        p_by: profile.id,
      });
      if (error) return `${HERE}?month=${label}&error=${errorCode(error, "app/admin/usage:invoice", "usage-bad")}`;
      revalidatePath(HERE);
      return `${HERE}?month=${label}&saved=invoice`;
    },
    { whileRunning: `${HERE}?error=still-saving` },
  );
}
