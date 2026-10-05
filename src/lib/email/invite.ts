import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { emailConfigured, fromAddress, sendEmail } from "@/lib/email/resend";
import { t, type Locale } from "@/lib/i18n";
import { APP_NAME, siteUrl } from "@/lib/env";

/**
 * The email that tells somebody they are on a farm's team, with a button that signs them in.
 *
 * == Why the link is ours and not Supabase's ==================================
 * `signInWithOtp` sends Supabase's own email, in English, and its link can only finish in
 * the browser that ASKED for it: the PKCE half it needs is a cookie on that device. An
 * invite is asked for on the owner's phone and opened on the worker's, so /auth/callback
 * would refuse exactly the person it is for. Here the admin API mints the link without
 * sending anything, and the hashed token goes to /auth/confirm, which verifies it on the
 * server for whichever device opens it.
 *
 * == Why /auth/confirm waits for a button press ===============================
 * Mail scanners (Outlook Safe Links, company gateways) open every link in a message to check
 * it. A link that signed in on GET would be used up by the scanner before the person saw it.
 */

export type InviteSendResult =
  | { ok: true }
  | {
      ok: false;
      reason: "email-not-configured" | "no-site-url" | "link-failed" | "send-failed";
      detail?: string;
    };

/**
 * Mint a one-time sign-in link for `email` and send it.
 *
 * Returns rather than throws, and names WHY. The person is on the team whether or not this
 * works, so a mail outage must not undo the invite; the caller tells the owner the email did
 * not go, and the person can still ask for a link on the sign-in page.
 */
export async function sendInviteEmail(
  service: SupabaseClient,
  opts: {
    email: string;
    name: string | null;
    farmId: string;
    farmName: string;
    inviterName: string | null;
    locale: Locale;
  },
): Promise<InviteSendResult> {
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  // Configuration only, never a request header: see `siteUrl()`.
  const origin = siteUrl();
  if (!origin) return { ok: false, reason: "no-site-url" };

  const { data, error } = await service.auth.admin.generateLink({ type: "magiclink", email: opts.email });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) return { ok: false, reason: "link-failed", detail: error?.message };

  const L = opts.locale;
  const link = `${origin}/auth/confirm?${new URLSearchParams({ token_hash: tokenHash, farm: opts.farmId, lang: L })}`;
  const login = `${origin}/login?${new URLSearchParams({ email: opts.email })}`;
  // Function replacers: a farm called "R$ & Sons" must not be read as a `$&` pattern.
  const fill = (s: string) =>
    s
      .replace("{inviter}", () => opts.inviterName?.trim() ?? "")
      .replace("{farm}", () => opts.farmName)
      .replace("{app}", () => APP_NAME)
      .replace("{name}", () => opts.name?.trim() ?? "")
      .replace("{magicLink}", () => t("auth.magicLink", L));

  const named = Boolean(opts.inviterName?.trim());
  const subject = fill(t(named ? "inviteEmail.subject" : "inviteEmail.subjectNoInviter", L));
  const greeting = fill(t(opts.name?.trim() ? "inviteEmail.greeting" : "inviteEmail.greetingNoName", L));
  const body = fill(t(named ? "inviteEmail.body" : "inviteEmail.bodyNoInviter", L));
  const howTo = t("inviteEmail.howTo", L);
  const button = fill(t("inviteEmail.button", L));
  const ignore = t("inviteEmail.ignore", L);
  const [fallbackBefore, fallbackAfter] = fill(t("inviteEmail.fallback", L)).split("{login}");

  const text = [
    greeting,
    "",
    body,
    howTo,
    "",
    link,
    "",
    `${fallbackBefore}${login}${fallbackAfter ?? ""}`,
    ignore,
  ].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(body)}<br>${escapeHtml(howTo)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#00572C;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button)}</a></p>`,
    `<p style="color:#555">${escapeHtml(fallbackBefore)}<a href="${escapeHtml(login)}">${escapeHtml(login)}</a>${escapeHtml(fallbackAfter ?? "")}<br>${escapeHtml(ignore)}</p>`,
  ].join("\n");

  const sent = await sendEmail({ to: opts.email, from: fromAddress(APP_NAME), subject, html, text });
  if (!sent.ok) return { ok: false, reason: "send-failed", detail: sent.error };
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
