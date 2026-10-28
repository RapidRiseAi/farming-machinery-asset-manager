"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { safePath } from "@/lib/safe-path";
import { isUuid } from "@/lib/ids";
import { runOnce } from "@/lib/request-claim";
import { errorCode } from "@/lib/action-errors";
import { captureError } from "@/lib/observability";
import { dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { supportRefusal } from "@/lib/support/refusals";
import { alertSupportInbox } from "@/lib/support/emails";
import { CUSTOMER_KINDS, type CustomerKind } from "@/lib/support/sla";

/**
 * Asking Rapid Rise for help, and answering them back, from inside the product.
 *
 * == It carries no authority ==================================================
 * `public.open_help_request` establishes who is asking from `auth.uid()`. The farm this
 * form posts is a CHOICE among the person's own farms (or a contractor's linked farms),
 * checked by the database against their access, never trusted: a farmer cannot open a
 * case against somebody else's farm by editing the HTML.
 *
 * == Why the path is sent =====================================================
 * Because the first reply to a support email is always "which screen were you on". It is
 * validated with `safePath` before it goes, and the database keeps only three named keys.
 *
 * == Rapid Rise hears at once =================================================
 * The database writes the in-app alert to every real admin in the same transaction. The
 * email to OPS_ALERT_EMAIL is sent here, after the case exists, and may fail without
 * undoing it (lib/support/emails.ts). A test case sends neither.
 */

function bounce(code: string, to = "/help"): never {
  redirect(`${to}?error=${encodeURIComponent(code)}`);
}

type CreatedRequest = {
  answer_by: string | null;
  is_test: boolean;
  farm_name: string | null;
};

export async function askForHelp(formData: FormData): Promise<void> {
  return runOnce(
    formData,
    "help:ask",
    async () => {
      const profile = await requireProfile();

      const subject = String(formData.get("subject") ?? "").trim();
      const message = String(formData.get("message") ?? "").trim();
      if (!subject) bounce("help-need-subject");
      if (!message) bounce("help-need-message");
      if (subject.length > 200) bounce("help-subject-long");
      if (message.length > 4000) bounce("help-message-long");

      const rawKind = String(formData.get("kind") ?? "help_request");
      const kind: CustomerKind = (CUSTOMER_KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as CustomerKind)
        : "help_request";
      const rawFarm = String(formData.get("farm_id") ?? "").trim();
      // Empty is "my own farm" (or, for a contractor, their own business). Anything else
      // must at least be an id; the database decides whether it is theirs.
      if (rawFarm && !isUuid(rawFarm)) bounce("support-farm-not-yours");

      // A form field, so never trusted as a path. `safePath` refuses anything that is not
      // a relative route on this site.
      const path = safePath(String(formData.get("path") ?? ""), "/help");

      const supabase = await createClient();
      const { data, error } = await supabase.rpc("open_help_request", {
        p_subject: subject,
        p_message: message,
        p_context: { path, locale: profile.lang },
        p_farm: rawFarm || null,
        p_kind: kind,
      });
      if (error) {
        const refusal = supportRefusal(error);
        bounce(refusal ?? errorCode(error, "help:ask", "help-failed"));
      }
      const ticketId = String(data ?? "");
      if (!isUuid(ticketId)) bounce("help-failed");

      // The case exists from here on, so nothing below may redirect to an error: it
      // would release the claim and a retry would open the case a second time.
      const created = await supabase.rpc("my_help_request", { p_ticket: ticketId });
      if (created.error) {
        captureError(created.error, { where: "help:ask:read-back" });
      } else {
        const c = (created.data as CreatedRequest | null) ?? null;
        const outcome = await alertSupportInbox({
          ticketId,
          subject,
          kind,
          who: c?.farm_name ?? profile.name,
          due: c?.answer_by ? dateTime(c.answer_by, "en") : t("support.dueUnknown", "en"),
          isTest: c?.is_test ?? true,
        });
        if (!outcome.sent && !["test-case", "no-alert-address", "email-not-configured"].includes(outcome.reason)) {
          captureError(new Error(`support alert email not sent: ${outcome.reason}`), { where: "help:ask:alert-email" });
        }
      }

      revalidatePath("/help");
      return `/help/${ticketId}?saved=1`;
    },
    { whileRunning: "/help?error=still-saving" },
  );
}

/** The customer answers Rapid Rise on a request they may see (theirs, or their farm's). */
export async function replyToHelp(formData: FormData): Promise<void> {
  const ticketId = String(formData.get("ticket_id") ?? "");
  const back = isUuid(ticketId) ? `/help/${ticketId}` : "/help";
  return runOnce(
    formData,
    "help:reply",
    async () => {
      await requireProfile();
      if (!isUuid(ticketId)) bounce("not-found");
      const body = String(formData.get("body") ?? "").trim();
      if (!body) bounce("support-need-message", back);
      if (body.length > 4000) bounce("support-message-long", back);

      const supabase = await createClient();
      const { error } = await supabase.rpc("reply_to_help_request", { p_ticket: ticketId, p_body: body });
      if (error) {
        const refusal = supportRefusal(error);
        bounce(refusal ?? errorCode(error, "help:reply"), back);
      }
      revalidatePath(back);
      revalidatePath("/help");
      return `${back}?sent=1`;
    },
    { whileRunning: `${back}?error=still-saving` },
  );
}
