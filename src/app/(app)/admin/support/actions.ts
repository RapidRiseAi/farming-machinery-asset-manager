"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isIsoDate, isUuid } from "@/lib/ids";
import { runOnce } from "@/lib/request-claim";
import { errorCode } from "@/lib/action-errors";
import { captureError } from "@/lib/observability";
import { supportRefusal } from "@/lib/support/refusals";
import { emailSupportReply } from "@/lib/support/emails";
import { CUSTOMER_KINDS } from "@/lib/support/sla";
import type { EmailScope } from "@/lib/email/resend";

/**
 * Rapid Rise working the support desk.
 *
 * Every action starts with `requireRole(["rr_admin"])`, which the database itself confirms
 * (two-step this session, never a test account), and then calls a SECURITY DEFINER
 * function with the admin's OWN session, never the service key: each function checks
 * `app.is_rr_support()` again, and `auth.uid()` names who answered, assigned or resolved.
 *
 * The one thing that leaves the database is the reply email to the customer, sent here
 * after the answer is saved and allowed to fail without undoing it; its outcome is
 * stamped on the message so the case page says whether it went.
 */

const ticketPath = (id: string) => `/admin/support/${id}`;

function fail(where: string, error: { code?: string; message?: string }, back: string): never {
  const refusal = supportRefusal(error);
  redirect(`${back}?error=${refusal ?? errorCode(error, where)}`);
}

function ticketOf(formData: FormData): string {
  const id = String(formData.get("ticket_id") ?? "");
  if (!isUuid(id)) redirect("/admin/support?error=not-found");
  return id;
}

type ReplyFacts = {
  message_id: string;
  ticket_id: string;
  subject: string;
  farm_id: string | null;
  workshop_id: string | null;
  is_test: boolean;
  customer: { id: string; name: string | null; email: string | null; language: string | null } | null;
};

/** A public answer: the customer reads it in the app and gets it by email. */
export async function replyAsStaff(formData: FormData): Promise<void> {
  const id = ticketOf(formData);
  const back = ticketPath(id);
  return runOnce(
    formData,
    "support:reply",
    async () => {
      await requireRole(["rr_admin"]);
      const body = String(formData.get("body") ?? "").trim();
      const status = String(formData.get("status") ?? "waiting") === "open" ? "open" : "waiting";
      if (!body) redirect(`${back}?error=support-need-message`);
      if (body.length > 4000) redirect(`${back}?error=support-message-long`);

      const supabase = await createClient();
      const { data, error } = await supabase.rpc("support_reply", { p_ticket: id, p_body: body, p_status: status });
      if (error) fail("support:reply", error, back);
      const facts = data as ReplyFacts;

      // Saved from here on: nothing below redirects to an error (it would release the
      // claim and a retry would post the answer twice).
      let outcome: { sent: true } | { sent: false; reason: string } = { sent: false, reason: "no-customer" };
      if (facts.customer) {
        const scope: EmailScope = facts.farm_id
          ? { farmId: facts.farm_id }
          : facts.workshop_id
            ? { workshopId: facts.workshop_id }
            : { userId: facts.customer.id };
        outcome = await emailSupportReply({
          messageId: facts.message_id,
          ticketId: id,
          subject: facts.subject,
          body,
          customer: facts.customer,
          scope,
        });
      }
      const marked = await supabase.rpc("support_mark_emailed", {
        p_message: facts.message_id,
        p_error: outcome.sent ? null : outcome.reason.slice(0, 300),
      });
      if (marked.error) captureError(marked.error, { where: "support:reply:mark-emailed" });

      revalidatePath(back);
      revalidatePath("/admin/support");
      return `${back}?sent=${outcome.sent ? "1" : "noemail"}`;
    },
    { whileRunning: `${back}?error=still-saving` },
  );
}

/** An internal note, or a conversation held by phone, WhatsApp, email or in person. */
export async function addStaffNote(formData: FormData): Promise<void> {
  const id = ticketOf(formData);
  const back = ticketPath(id);
  return runOnce(
    formData,
    "support:note",
    async () => {
      await requireRole(["rr_admin"]);
      const body = String(formData.get("body") ?? "").trim();
      const channel = String(formData.get("channel") ?? "in_app");
      if (!body) redirect(`${back}?error=support-need-message`);
      const supabase = await createClient();
      const { error } = await supabase.rpc("support_add_note", { p_ticket: id, p_body: body, p_channel: channel });
      if (error) fail("support:note", error, back);
      revalidatePath(back);
      return `${back}?saved=1`;
    },
    { whileRunning: `${back}?error=still-saving` },
  );
}

/** Open, waiting, resolved or closed. Resolving or closing needs the resolution in words. */
export async function setTicketStatus(formData: FormData): Promise<void> {
  await requireRole(["rr_admin"]);
  const id = ticketOf(formData);
  const back = ticketPath(id);
  const status = String(formData.get("status") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  if ((status === "resolved" || status === "closed") && !resolution) redirect(`${back}?error=support-need-resolution`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_set_status", {
    p_ticket: id,
    p_status: status,
    p_resolution: resolution || null,
  });
  if (error) fail("support:status", error, back);
  revalidatePath(back);
  revalidatePath("/admin/support");
  redirect(`${back}?saved=1`);
}

/** Who on the team has it. Empty takes it off everybody. */
export async function assignTicket(formData: FormData): Promise<void> {
  await requireRole(["rr_admin"]);
  const id = ticketOf(formData);
  const back = ticketPath(id);
  const user = String(formData.get("assignee") ?? "");
  if (user && !isUuid(user)) redirect(`${back}?error=support-assignee-invalid`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_assign", { p_ticket: id, p_user: user || null });
  if (error) fail("support:assign", error, back);
  revalidatePath(back);
  revalidatePath("/admin/support");
  redirect(`${back}?saved=1`);
}

/**
 * A case for a client who phoned, emailed, sent a WhatsApp or was visited, opened from
 * their client page for one person on the farm, who then sees it under "What you have
 * asked" with the summary as Rapid Rise's first answer.
 */
export async function openTicketForClient(formData: FormData): Promise<void> {
  const farm = String(formData.get("farm_id") ?? "");
  const back = isUuid(farm) ? `/admin/farms/${farm}` : "/admin/farms";
  return runOnce(
    formData,
    "support:open-for-client",
    async () => {
      await requireRole(["rr_admin"]);
      if (!isUuid(farm)) redirect("/admin/farms?error=not-found");
      const person = String(formData.get("user_id") ?? "");
      const subject = String(formData.get("subject") ?? "").trim();
      const message = String(formData.get("message") ?? "").trim();
      const channel = String(formData.get("channel") ?? "phone");
      const rawKind = String(formData.get("kind") ?? "help_request");
      const kind = (CUSTOMER_KINDS as readonly string[]).includes(rawKind) ? rawKind : "help_request";
      if (!isUuid(person)) redirect(`${back}?error=support-person-invalid`);
      if (!subject || !message) redirect(`${back}?error=support-need-message`);
      if (subject.length > 200 || message.length > 4000) redirect(`${back}?error=support-message-long`);

      const supabase = await createClient();
      const { data, error } = await supabase.rpc("support_open_for_customer", {
        p_farm: farm,
        p_user: person,
        p_subject: subject,
        p_message: message,
        p_channel: channel,
        p_kind: kind,
      });
      if (error) fail("support:open-for-client", error, back);
      const ticket = String(data ?? "");
      revalidatePath(back);
      revalidatePath("/admin/support");
      return isUuid(ticket) ? `${ticketPath(ticket)}?saved=1` : `${back}?saved=1`;
    },
    { whileRunning: `${back}?error=still-saving` },
  );
}

// == The support calendar and contact channels (/admin/support/settings) =========

const SETTINGS = "/admin/support/settings";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Hours, the cutoff, the channels customers are shown. Phone and WhatsApp blank = hidden. */
export async function updateSupportSettings(formData: FormData): Promise<void> {
  await requireRole(["rr_admin"]);
  const field = (k: string) => String(formData.get(k) ?? "").trim();
  const times = ["opens_at", "closes_at", "same_day_cutoff", "next_day_due"].map(field);
  if (times.some((v) => !TIME.test(v))) redirect(`${SETTINGS}?error=support-settings-invalid`);
  const days = formData
    .getAll("working_days")
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  if (days.length === 0) redirect(`${SETTINGS}?error=support-settings-invalid`);

  const supabase = await createClient();
  const { error } = await supabase.rpc("support_update_settings", {
    p_email: field("email"),
    p_phone: field("phone") || null,
    p_whatsapp: field("whatsapp") || null,
    p_opens_at: times[0],
    p_closes_at: times[1],
    p_same_day_cutoff: times[2],
    p_next_day_due: times[3],
    p_working_days: days.join(","),
  });
  if (error) fail("support:settings", error, SETTINGS);
  revalidatePath(SETTINGS);
  revalidatePath("/help");
  redirect(`${SETTINGS}?saved=1`);
}

/** A day nobody is on the desk: a public holiday, or one declared later. */
export async function setSupportHoliday(formData: FormData): Promise<void> {
  await requireRole(["rr_admin"]);
  const day = String(formData.get("day") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!isIsoDate(day) || !name || name.length > 80) redirect(`${SETTINGS}?error=support-holiday-invalid`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_holiday_set", { p_day: day, p_name: name });
  if (error) fail("support:holiday-set", error, SETTINGS);
  revalidatePath(SETTINGS);
  redirect(`${SETTINGS}?saved=1`);
}

export async function removeSupportHoliday(formData: FormData): Promise<void> {
  await requireRole(["rr_admin"]);
  const day = String(formData.get("day") ?? "");
  if (!isIsoDate(day)) redirect(`${SETTINGS}?error=support-holiday-invalid`);
  const supabase = await createClient();
  const { error } = await supabase.rpc("support_holiday_remove", { p_day: day });
  if (error) fail("support:holiday-remove", error, SETTINGS);
  revalidatePath(SETTINGS);
  redirect(`${SETTINGS}?deleted=1`);
}
