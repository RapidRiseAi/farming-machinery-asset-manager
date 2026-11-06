import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { captureError } from "@/lib/observability";

/**
 * Rapid Rise's own banking details (billing_settings.eft_instructions, 20261105100000).
 *
 * ONLY for money owed to Rapid Rise: a farm's or workshop's FleetWise bill, on the pages and
 * the invoice that collect it. A workshop's invoice to a farm is paid to the workshop, and
 * printing these details on it would send a customer's money to the wrong business, so
 * `eft.test.ts` fails if anything outside the known list reads them.
 *
 * Null when none are set, or when the read fails: the page then offers the card alone, and
 * the failure is reported rather than swallowed.
 */
export async function rapidRiseEft(client: SupabaseClient): Promise<string | null> {
  const { data, error } = await client
    .from("billing_settings")
    .select("eft_instructions")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    captureError(error, { where: "billing:eft" });
    return null;
  }
  return (data as { eft_instructions: string | null } | null)?.eft_instructions?.trim() || null;
}
