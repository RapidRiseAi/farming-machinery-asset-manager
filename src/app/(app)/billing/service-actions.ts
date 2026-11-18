"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { effectiveFarmRole, requireProfile } from "@/lib/auth";
import { isUuid } from "@/lib/ids";
import { runOnce } from "@/lib/request-claim";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The owner accepts a Done-For-You agreement or an optional service order (20261120100000).
 *
 * Only the business's owner accepts: not a manager, and not Rapid Rise on their behalf. The
 * amount shown is posted back and the database refuses it if it moved (`service-changed`), if
 * the offer expired, or if the business is in its grace. The service role carries the call,
 * with the owner's id passed and checked again inside (`app.service_owner_actor`), the same
 * shape as accepting a mid-period change.
 */

function bounce(code: string): never {
  redirect(`/billing?error=${encodeURIComponent(code)}#services`);
}

async function requireOwner(): Promise<{ id: string; farmId: string }> {
  const profile = await requireProfile();
  const farmId = profile.farm_id;
  if (!farmId) bounce("no-farm");
  if ((await effectiveFarmRole(farmId, profile)) !== "owner") bounce("forbidden");
  return { id: profile.id, farmId };
}

function cents(formData: FormData, name: string): number | null {
  const n = Number(String(formData.get(name) ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function acceptAgreement(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  const quoteId = String(formData.get("quote_id") ?? "");
  const total = cents(formData, "recurring_cents");
  if (!isUuid(quoteId)) bounce("missing-id");
  if (total == null) bounce("service-changed");
  if (formData.get("accept") !== "1") bounce("service-terms-required");
  return runOnce(
    formData,
    "billing:accept-agreement",
    async () => {
      const { error } = await createServiceClient().rpc("dfy_accept", {
        p_by: owner.id,
        p_quote: quoteId,
        p_recurring: total,
      });
      if (error) return `/billing?error=${errorCode(error, "billing:accept-agreement", "service-not-open")}#services`;
      revalidatePath("/billing");
      return "/billing?saved=agreement-accepted#services";
    },
    { whileRunning: "/billing?saved=checking#services" },
  );
}

export async function acceptServiceOrder(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  const orderId = String(formData.get("order_id") ?? "");
  const amount = cents(formData, "amount_cents");
  if (!isUuid(orderId)) bounce("missing-id");
  if (amount == null) bounce("service-changed");
  if (formData.get("accept") !== "1") bounce("service-terms-required");
  return runOnce(
    formData,
    "billing:accept-order",
    async () => {
      const { error } = await createServiceClient().rpc("service_order_accept", {
        p_by: owner.id,
        p_order: orderId,
        p_amount: amount,
      });
      if (error) return `/billing?error=${errorCode(error, "billing:accept-order", "service-not-open")}#services`;
      revalidatePath("/billing");
      return "/billing?saved=order-accepted#services";
    },
    { whileRunning: "/billing?saved=checking#services" },
  );
}
