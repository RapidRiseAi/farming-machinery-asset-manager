import "server-only";

import { emailConfigured, sendEmail, type EmailScope } from "@/lib/email/resend";
import { siteUrl } from "@/lib/env";
import { t, type Locale } from "@/lib/i18n";
import { COMPANY } from "@/lib/legal";

/**
 * The two emails the support desk sends.
 *
 * 1. To Rapid Rise when a customer asks (`alertSupportInbox`): to OPS_ALERT_EMAIL when it is
 *    set (or AI_ALERT_EMAIL, as the cron alerts do). Unset, the in-app alert still reaches
 *    every real admin, and the admin overview says email is off. Rapid Rise's own mail
 *    (scope "platform"): the case's subject, farm and deadline, never the question itself
 *    or the asker's contact details, which are read on the case page behind two-step.
 *    A test case sends nothing.
 *
 * 2. To the customer when Rapid Rise answers (`emailSupportReply`): to the person who asked,
 *    in their language, with the answer and a link back to the conversation. Sent whatever
 *    their alert settings say, because they asked for an answer. Scoped to them, so the
 *    test-account fence applies (a test account is only ever emailed at a test address).
 *    Reply-To is the support address, so answering the email reaches a person.
 *
 * Neither throws: an email that did not go must not undo a case that was opened or an
 * answer that was saved. Each returns what happened so the caller can record it.
 */

export type MailOutcome = { sent: true } | { sent: false; reason: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Where Rapid Rise's support alerts go by email, or null when no address is set. */
export function supportAlertAddress(): string | null {
  const to = (process.env.OPS_ALERT_EMAIL || process.env.AI_ALERT_EMAIL || "").trim();
  return to || null;
}

function from(): string {
  const base = process.env.EMAIL_FROM || "documents@fleetwise.app";
  return `Fleet Wise support <${base}>`;
}

/** Placeholders filled with function replacers, so a "$&" in a subject stays literal. */
function fill(template: string, vars: Record<string, string>): string {
  let s = template;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, () => v);
  return s;
}

export async function alertSupportInbox(input: {
  ticketId: string;
  subject: string;
  kind: string;
  /** The farm or contractor it is about, as Rapid Rise knows them. */
  who: string;
  /** When the first answer is due, already formatted for a person. */
  due: string;
  isTest: boolean;
}): Promise<MailOutcome> {
  if (input.isTest) return { sent: false, reason: "test-case" };
  const to = supportAlertAddress();
  if (!to) return { sent: false, reason: "no-alert-address" };
  if (!emailConfigured()) return { sent: false, reason: "email-not-configured" };
  const origin = siteUrl();
  const link = origin ? `${origin}/admin/support/${input.ticketId}` : `/admin/support/${input.ticketId}`;
  const L: Locale = "en";
  const kind = t(`support.kind.${input.kind}`, L);
  const subject = fill(t("support.alertEmailSubject", L), { who: input.who, subject: input.subject });
  const lines = [
    fill(t("support.alertEmailBody", L), { kind, who: input.who }),
    "",
    input.subject,
    fill(t("support.alertEmailDue", L), { due: input.due }),
    "",
    link,
  ];
  try {
    const result = await sendEmail({
      scope: "platform",
      to,
      from: from(),
      subject: subject.slice(0, 180),
      text: lines.join("\n"),
      html: lines.map((l) => (l === link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : `<p>${escapeHtml(l)}</p>`)).join("\n"),
      idempotencyKey: `support-new-${input.ticketId}`,
    });
    return result.ok ? { sent: true } : { sent: false, reason: result.error };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "send-threw" };
  }
}

export async function emailSupportReply(input: {
  messageId: string;
  ticketId: string;
  subject: string;
  body: string;
  customer: { id: string; name: string | null; email: string | null; language: string | null };
  scope: EmailScope;
}): Promise<MailOutcome> {
  const to = (input.customer.email ?? "").trim();
  if (!to) return { sent: false, reason: "no-address" };
  if (!emailConfigured()) return { sent: false, reason: "email-not-configured" };
  const origin = siteUrl();
  if (!origin) return { sent: false, reason: "no-site-url" };
  const L: Locale = input.customer.language === "af" ? "af" : "en";
  const link = `${origin}/help/${input.ticketId}`;
  const name = input.customer.name?.trim() ?? "";
  const greeting = name ? fill(t("support.replyEmailGreeting", L), { name }) : t("support.replyEmailGreetingNoName", L);
  const lead = fill(t("support.replyEmailLead", L), { subject: input.subject });
  const action = t("support.replyEmailAction", L);
  const footer = fill(t("support.replyEmailFooter", L), { email: COMPANY.email });
  const subject = fill(t("support.replyEmailSubject", L), { subject: input.subject });
  const text = [greeting, "", lead, "", input.body, "", `${action}: ${link}`, "", footer].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(lead)}</p>`,
    `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #00572C;white-space:pre-wrap">${escapeHtml(input.body)}</blockquote>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#00572C;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action)}</a></p>`,
    `<p style="color:#555">${escapeHtml(footer)}</p>`,
  ].join("\n");
  try {
    const result = await sendEmail({
      scope: input.scope,
      to,
      from: from(),
      replyTo: COMPANY.email,
      subject: subject.slice(0, 180),
      text,
      html,
      // The message id: a retried send is the same email, sent once.
      idempotencyKey: `support-reply-${input.messageId}`,
    });
    return result.ok ? { sent: true } : { sent: false, reason: result.error };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "send-threw" };
  }
}
