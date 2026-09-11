import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { emailConfigured, sendEmail, fromAddress } from "@/lib/email/resend";
import { t, type Lang } from "@/lib/i18n";
import { APP_NAME, siteUrl } from "@/lib/env";

/**
 * Proving that a sign-up's email address actually works.
 *
 * ── Why this is ours and not Supabase's ──────────────────────────────────────
 * Supabase can hold a user unconfirmed and email them itself, but an unconfirmed user
 * cannot sign in — and `signUp` signs them in and sends them to `/activate` to pay. Putting
 * an email round trip between "I want this" and "here is my card" is the wrong place for
 * friction in a product bought on a phone in a shed. So the auth user stays confirmed and
 * this is a separate, non-blocking check: it tells the truth about the address, prompts
 * until it is proven, and gates nothing.
 *
 * ── The token never touches the database ─────────────────────────────────────
 * Only its SHA-256 is stored. `public.users` is readable by the rest of the farm — that is
 * what the team screen is — and RLS filters rows, not columns; this codebase has already
 * been caught by that distinction once, on `billing_payment_methods.authorization_code`.
 * A colleague reading the hash learns nothing and cannot confirm somebody else's address.
 */

/** 72 hours. Long enough for somebody who signs up on a Friday, short enough to expire. */
export const VERIFY_MAX_AGE_HOURS = 72;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintToken(): string {
  // 32 bytes, url-safe. The id is not in the token: it is looked up BY the hash, so a token
  // carries no information about whose it is.
  return randomBytes(32).toString("base64url");
}

export type VerifySendResult =
  | { ok: true }
  | {
      ok: false;
      reason: "email-not-configured" | "no-email" | "no-site-url" | "save-failed" | "send-failed";
      detail?: string;
    };

/**
 * Mint a token, store its hash, and email the link.
 *
 * Returns rather than throws, and names WHY — the sign-up must not fail because our mail
 * provider is down. A farm that has paid and cannot be emailed is a support problem; a farm
 * that could not sign up because of it is a lost customer.
 */
export async function sendVerificationEmail(
  service: SupabaseClient,
  opts: { userId: string; email: string | null; name: string | null; locale: Lang },
): Promise<VerifySendResult> {
  if (!opts.email) return { ok: false, reason: "no-email" };
  if (!emailConfigured()) return { ok: false, reason: "email-not-configured" };
  // Configuration only — see `siteUrl()`. A link built from a request header and posted to
  // somebody's inbox over our name is a phishing email we wrote ourselves. Refusing to send
  // is strictly better than sending one that points at "undefined/verify/…" or worse.
  const origin = siteUrl();
  if (!origin) return { ok: false, reason: "no-site-url" };

  const token = mintToken();
  const { error } = await service.rpc("set_email_verification", {
    p_user: opts.userId,
    p_hash: hashToken(token),
  });
  if (error) return { ok: false, reason: "save-failed", detail: error.message };

  const link = `${origin}/verify/${token}`;
  const L = opts.locale;
  const greeting = opts.name
    ? t("verifyEmail.greeting", L).replace("{name}", opts.name)
    : t("verifyEmail.greetingNoName", L);

  const text = [
    greeting,
    "",
    t("verifyEmail.why", L),
    "",
    link,
    "",
    t("verifyEmail.expiry", L).replace("{hours}", String(VERIFY_MAX_AGE_HOURS)),
    t("verifyEmail.ignore", L),
  ].join("\n");

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(t("verifyEmail.why", L))}</p>`,
    `<p><a href="${escapeHtml(link)}">${escapeHtml(t("verifyEmail.button", L))}</a></p>`,
    `<p style="color:#555">${escapeHtml(t("verifyEmail.expiry", L).replace("{hours}", String(VERIFY_MAX_AGE_HOURS)))}<br>${escapeHtml(t("verifyEmail.ignore", L))}</p>`,
  ].join("\n");

  const sent = await sendEmail({
    to: opts.email,
    from: fromAddress(APP_NAME),
    subject: t("verifyEmail.subject", L).replace("{app}", APP_NAME),
    html,
    text,
  });
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
