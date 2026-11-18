"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { randsToCents } from "@/lib/trips";

const HERE = "/admin/usage";

/**
 * What Rapid Rise pays for each, and its markup, for Rapid Rise's own cost view. Nothing is
 * invoiced from these any more (20261118120100): storage is billed as the pooled allowance plus
 * R49 blocks, and paid WhatsApp through the usage ledger under the customer's spending limit, so
 * the hand-raised "usage invoice" this page used to offer (every measured gigabyte at cost plus
 * the markup, with no allowance) is gone and cannot bill the same use a second time.
 * Through the admin's own client.
 */
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
