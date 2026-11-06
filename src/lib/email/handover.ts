import "server-only";

import { emailConfigured, sendEmail } from "@/lib/email/resend";
import { APP_NAME, siteUrl } from "@/lib/env";
import { t, type Locale } from "@/lib/i18n";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fill(template: string, vars: Record<string, string>): string {
  let s = template;
  for (const [key, value] of Object.entries(vars)) s = s.replaceAll(`{${key}}`, () => value);
  return s;
}

/** Tell somebody they have been offered a business, and where to answer. */
export async function sendOwnershipOffer(opts: {
  email: string;
  fromName: string;
  businessName: string;
  farmId: string;
  locale: Locale;
}): Promise<{ ok: boolean }> {
  const origin = siteUrl();
  if (!emailConfigured() || !origin) return { ok: false };
  const line = (key: string) =>
    fill(t(`handover.mail.${key}`, opts.locale), { from: opts.fromName, business: opts.businessName, app: APP_NAME });
  const link = `${origin}/handover`;
  const sent = await sendEmail({
    scope: { farmId: opts.farmId },
    to: opts.email,
    from: `${APP_NAME} <${process.env.EMAIL_FROM || "documents@fleetwise.app"}>`,
    subject: line("subject"),
    text: [line("body"), "", line("what"), "", link].join("\n"),
    html: [
      `<p>${escapeHtml(line("body"))}</p>`,
      `<p>${escapeHtml(line("what"))}</p>`,
      `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#00572C;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(line("button"))}</a></p>`,
    ].join("\n"),
  });
  return { ok: sent.ok };
}
