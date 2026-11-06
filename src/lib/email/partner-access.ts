import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { emailConfigured, fromAddress, sendEmail, type EmailScope } from "@/lib/email/resend";
import { APP_NAME, siteUrl } from "@/lib/env";
import { t, type Locale } from "@/lib/i18n";
import { supportAlertAddress } from "@/lib/support/emails";

/**
 * The emails around partners and contractors: the sign-in a contractor gets, the sign-in an
 * approved partner gets, and the two sides of an application.
 *
 * A sign-in link goes to the address it opens and to nobody else. The button lands on
 * /auth/confirm, which waits for a press, because mail scanners open every link they see
 * (lib/email/invite.ts has that story). None of these throw: a mail outage must not undo a
 * connection that was made.
 */

export type MailResult = { ok: true } | { ok: false; reason: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Function replacers: a business called "R$ & Sons" must not be read as a `$&` pattern. */
function fill(template: string, vars: Record<string, string>): string {
  let s = template;
  for (const [key, value] of Object.entries(vars)) s = s.replaceAll(`{${key}}`, () => value);
  return s;
}

function htmlButton(link: string, label: string): string {
  return `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#00572C;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`;
}

function platformFrom(): string {
  return `${APP_NAME} <${process.env.EMAIL_FROM || "documents@fleetwise.app"}>`;
}

/** Mint a sign-in for `email`. Its hash is for an email to that same address, never a page. */
export async function mintSignIn(
  service: SupabaseClient,
  email: string,
): Promise<{ tokenHash: string | null; userId: string | null }> {
  const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
  if (error) return { tokenHash: null, userId: null };
  return { tokenHash: data?.properties?.hashed_token ?? null, userId: data?.user?.id ?? null };
}

function confirmLink(origin: string, tokenHash: string, locale: Locale): string {
  return `${origin}/auth/confirm?${new URLSearchParams({ token_hash: tokenHash, lang: locale })}`;
}

/**
 * A contractor's way in. Scoped to the farm, so the test-account fence applies, and sent in
 * the farm's name. Carries one line about partnering, because this is the moment they have
 * just seen what the product does.
 */
export async function sendContractorSignIn(opts: {
  email: string;
  name: string;
  farmId: string;
  farmName: string;
  tokenHash: string;
  locale: Locale;
}): Promise<MailResult> {
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  const origin = siteUrl();
  if (!origin) return { ok: false, reason: "no-site-url" };

  const L = opts.locale;
  const link = confirmLink(origin, opts.tokenHash, L);
  const login = `${origin}/login?${new URLSearchParams({ email: opts.email })}`;
  const partnerPage = `${origin}/become-a-partner`;
  const vars = { farm: opts.farmName, app: APP_NAME, name: opts.name.trim() };
  const line = (key: string) => fill(t(`partnerMail.${key}`, L), vars);

  const greeting = line(vars.name ? "greeting" : "greetingNoName");
  const body = line("contractorBody");
  const button = line("contractorButton");
  const nextTime = line("contractorNextTime");
  const pitch = line("contractorPitch");
  const pitchLink = line("contractorPitchLink");
  const ignore = line("ignore");

  const text = [greeting, "", body, "", link, "", `${nextTime} ${login}`, "", pitch, `${pitchLink}: ${partnerPage}`, "", ignore].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    htmlButton(link, button),
    `<p style="color:#555">${escapeHtml(nextTime)} <a href="${escapeHtml(login)}">${escapeHtml(login)}</a></p>`,
    `<p>${escapeHtml(pitch)} <a href="${escapeHtml(partnerPage)}">${escapeHtml(pitchLink)}</a></p>`,
    `<p style="color:#555">${escapeHtml(ignore)}</p>`,
  ].join("\n");

  const scope: EmailScope = { farmId: opts.farmId };
  const sent = await sendEmail({
    scope,
    to: opts.email,
    from: fromAddress(opts.farmName),
    subject: line("contractorSubject"),
    html,
    text,
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.refused ? "refused" : "send-failed" };
}

/** Rapid Rise approved them: their way in. */
export async function sendPartnerApproved(opts: {
  email: string;
  name: string;
  businessName: string;
  tokenHash: string;
  locale: Locale;
}): Promise<MailResult> {
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  const origin = siteUrl();
  if (!origin) return { ok: false, reason: "no-site-url" };

  const L = opts.locale;
  const link = confirmLink(origin, opts.tokenHash, L);
  const vars = { business: opts.businessName, app: APP_NAME, name: opts.name.trim() };
  const line = (key: string) => fill(t(`partnerMail.${key}`, L), vars);

  const greeting = line(vars.name ? "greeting" : "greetingNoName");
  const body = line("approvedBody");
  const button = line("approvedButton");
  const ignore = line("ignore");

  const sent = await sendEmail({
    scope: "platform",
    to: opts.email,
    from: platformFrom(),
    subject: line("approvedSubject"),
    text: [greeting, "", body, "", link, "", ignore].join("\n"),
    html: [
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(body)}</p>`,
      htmlButton(link, button),
      `<p style="color:#555">${escapeHtml(ignore)}</p>`,
    ].join("\n"),
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.refused ? "refused" : "send-failed" };
}

/** Tell the applicant we have it and what happens next. */
export async function sendApplicationReceived(opts: {
  email: string;
  name: string;
  businessName: string;
  locale: Locale;
}): Promise<MailResult> {
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  const L = opts.locale;
  const vars = { business: opts.businessName, app: APP_NAME, name: opts.name.trim() };
  const line = (key: string) => fill(t(`partnerMail.${key}`, L), vars);

  const greeting = line(vars.name ? "greeting" : "greetingNoName");
  const body = line("receivedBody");
  const next = line("receivedNext");

  const sent = await sendEmail({
    scope: "platform",
    to: opts.email,
    from: platformFrom(),
    subject: line("receivedSubject"),
    text: [greeting, "", body, "", next].join("\n"),
    html: [`<p>${escapeHtml(greeting)}</p>`, `<p>${escapeHtml(body)}</p>`, `<p>${escapeHtml(next)}</p>`].join("\n"),
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.refused ? "refused" : "send-failed" };
}

/**
 * Tell Rapid Rise. The business and where it works, never the applicant's contact details or
 * who they named: those are read in the console, behind two-step, as for a support case.
 */
export async function alertPartnerApplication(input: {
  businessName: string;
  trade: string;
  area: string;
}): Promise<MailResult> {
  const to = supportAlertAddress();
  if (!to) return { ok: false, reason: "no-alert-address" };
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  const origin = siteUrl();
  const link = origin ? `${origin}/admin/partners` : null;

  const summary = `${input.businessName} (${input.trade}), ${input.area}`;
  const sent = await sendEmail({
    scope: "platform",
    to,
    from: platformFrom(),
    subject: `Partner request: ${input.businessName}`,
    text: [`A business has asked to become a partner.`, "", summary, "", link ?? ""].join("\n"),
    html: [
      `<p>A business has asked to become a partner.</p>`,
      `<p>${escapeHtml(summary)}</p>`,
      link ? htmlButton(link, "Review the request") : "",
    ].join("\n"),
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.refused ? "refused" : "send-failed" };
}
