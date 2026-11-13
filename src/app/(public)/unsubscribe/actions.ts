"use server";

import { redirect } from "next/navigation";

import { turnOffAlertEmails, verifyUnsubscribe } from "@/lib/email/unsubscribe";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The button on /unsubscribe. No sign-in: the signed link is the authority, checked again
 * here because a server action is an endpoint of its own. A wrong signature goes back to the
 * neutral page and changes nothing.
 */
export async function confirmUnsubscribe(formData: FormData): Promise<void> {
  const userId = String(formData.get("u") ?? "");
  const signature = String(formData.get("s") ?? "");
  if (!verifyUnsubscribe(userId, signature)) redirect("/unsubscribe");

  const back = `/unsubscribe?u=${encodeURIComponent(userId)}&s=${encodeURIComponent(signature)}`;
  const result = await turnOffAlertEmails(createServiceClient(), userId);
  if (!result.ok) {
    captureError(new Error("unsubscribe: alert emails not switched off"), { where: "unsubscribe:page" });
    redirect(`${back}&error=unsubscribe-failed`);
  }
  redirect(`${back}&done=1`);
}
