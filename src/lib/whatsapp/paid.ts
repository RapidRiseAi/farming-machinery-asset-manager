import type { SupabaseClient } from "@supabase/supabase-js";

import { captureError } from "@/lib/observability";

/** Into the observability layer as a code, never the provider body (it can carry a phone number). */
function reportFailure(where: string, error: unknown) {
  captureError(new Error(`${where} failed (${error instanceof Error ? error.name : typeof error})`), { where });
}

/**
 * Paid WhatsApp on the customer's spending limit (20261118120200; BRIEF section 12; decision 24).
 *
 * Every message the business sends is HELD on the AI ledger before it goes out and SETTLED from
 * Meta's own delivery status: Meta "only charges when a message is delivered" and says on the
 * delivered (or read) status whether it was billable (`pricing.type` "regular") or free
 * (free_customer_service, free_entry_point, free_group_customer_service); a free message settles
 * at R0, a failed one at R0, one never answered in 72 hours at R0 (the nightly sweep). Source:
 * developers.facebook.com/docs/whatsapp/pricing and the messages status webhook reference, read
 * 17 Nov 2026. Until Rapid Rise switches WhatsApp billing on (a start date and per-category
 * rates), the hold answers "not metered" and sending is exactly as before.
 */

/** Meta's pricing categories this app sends in: notification templates are utility; replies are service. */
export type WhatsAppCategory = "utility" | "service";

export type PaidHold =
  | { kind: "unmetered" }
  | { kind: "held"; reservationId: string }
  | { kind: "refused"; reason: string };

/** Hold the most this message may cost the customer, or say why it may not be sent. */
export async function holdWhatsAppMessage(
  db: SupabaseClient,
  input: { farmId: string; userId: string; category: WhatsAppCategory },
): Promise<PaidHold> {
  const { data, error } = await db.rpc("whatsapp_usage_reserve", {
    p_farm: input.farmId,
    p_user: input.userId,
    p_category: input.category,
  });
  if (error) {
    reportFailure("whatsapp:paid-hold", error);
    return { kind: "refused", reason: "unavailable" };
  }
  const answer = (data ?? {}) as { ok?: boolean; metered?: boolean; id?: string; reason?: string };
  if (!answer.ok) return { kind: "refused", reason: /^[a-z_]{1,40}$/.test(answer.reason ?? "") ? String(answer.reason) : "unavailable" };
  if (!answer.metered) return { kind: "unmetered" };
  return answer.id ? { kind: "held", reservationId: answer.id } : { kind: "refused", reason: "unavailable" };
}

/** Meta took the message: its id ties the delivery status to the hold. */
export async function recordWhatsAppSent(db: SupabaseClient, hold: PaidHold, providerMessageId: string): Promise<void> {
  if (hold.kind !== "held") return;
  const { error } = await db.rpc("whatsapp_usage_sent", { p_reservation: hold.reservationId, p_provider_message_id: providerMessageId });
  if (error) reportFailure("whatsapp:paid-sent", error);
}

/** The send failed before Meta took it: the hold settles at R0. */
export async function releaseWhatsAppHold(db: SupabaseClient, hold: PaidHold, errorCode: string): Promise<void> {
  if (hold.kind !== "held") return;
  const { error } = await db.rpc("whatsapp_usage_release", { p_reservation: hold.reservationId, p_error_code: errorCode });
  if (error) reportFailure("whatsapp:paid-release", error);
}

export type WhatsAppStatus = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  pricing?: { billable?: boolean; type?: string; category?: string };
};

/**
 * A status from Meta's webhook. Only one carrying pricing, or a failure, settles anything; a
 * repeated status settles nothing twice (the database keeps the first).
 */
export async function settleWhatsAppStatus(db: SupabaseClient, status: WhatsAppStatus): Promise<void> {
  if (!status.pricing && status.status !== "failed") return;
  const clean = (value: string | undefined) => (value && /^[a-z_-]{1,40}$/.test(value) ? value : null);
  const { error } = await db.rpc("whatsapp_usage_settle", {
    p_provider_message_id: status.id,
    p_status: status.status,
    p_billable: typeof status.pricing?.billable === "boolean" ? status.pricing.billable : null,
    p_type: clean(status.pricing?.type),
    p_category: clean(status.pricing?.category),
  });
  if (error) throw new Error("whatsapp_usage_settle_failed");
}
