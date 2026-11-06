import "server-only";

import { emailConfigured, sendEmail } from "@/lib/email/resend";
import { APP_NAME } from "@/lib/env";
import { t, type Locale } from "@/lib/i18n";

/**
 * The two emails of a permanent closure. The first is what makes it the owner's decision: the
 * address on the account, not whoever is holding a signed-in phone.
 */

export type MailResult = { ok: true } | { ok: false; reason: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fill(template: string, vars: Record<string, string>): string {
  let s = template;
  for (const [key, value] of Object.entries(vars)) s = s.replaceAll(`{${key}}`, () => value);
  return s;
}

function from(): string {
  return `${APP_NAME} <${process.env.EMAIL_FROM || "documents@fleetwise.app"}>`;
}

export async function sendClosureConfirmation(opts: {
  email: string;
  businessName: string;
  link: string;
  farmId: string;
  locale: Locale;
}): Promise<MailResult> {
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  const line = (key: string) => fill(t(`closure.mail.${key}`, opts.locale), { business: opts.businessName, app: APP_NAME });
  const button = line("confirmButton");
  const sent = await sendEmail({
    scope: { farmId: opts.farmId },
    to: opts.email,
    from: from(),
    subject: line("confirmSubject"),
    text: [line("confirmBody"), "", opts.link, "", line("confirmIgnore")].join("\n"),
    html: [
      `<p>${escapeHtml(line("confirmBody"))}</p>`,
      `<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;padding:12px 20px;background:#B42318;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button)}</a></p>`,
      `<p style="color:#555">${escapeHtml(line("confirmIgnore"))}</p>`,
    ].join("\n"),
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.refused ? "refused" : "send-failed" };
}

export async function sendClosureDone(opts: { email: string; businessName: string; locale: Locale }): Promise<MailResult> {
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  const line = (key: string) => fill(t(`closure.mail.${key}`, opts.locale), { business: opts.businessName, app: APP_NAME });
  const sent = await sendEmail({
    scope: "platform",
    to: opts.email,
    from: from(),
    subject: line("doneSubject"),
    text: [line("doneBody"), "", line("doneKept")].join("\n"),
    html: `<p>${escapeHtml(line("doneBody"))}</p>\n<p>${escapeHtml(line("doneKept"))}</p>`,
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.refused ? "refused" : "send-failed" };
}
