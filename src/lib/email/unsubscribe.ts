import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * "Turn these emails off", from the alert email itself, with no sign-in.
 *
 * The link carries the person's id and a signature, never a secret: the signature is an
 * HMAC-SHA256 over the purpose and the id, so it can switch off this person's alert emails
 * and nothing else, and a link for one person says nothing about another's. It does not
 * expire, because an old alert is exactly where somebody looks for the way out.
 *
 * == The key ===================================================================
 * `EMAIL_LINK_SECRET` when it is set. Otherwise a key derived from the service-role key (an
 * HMAC under a fixed label), which every deployment that sends email already has, so the
 * links work without a new variable; the derived key is not the service key and cannot be
 * turned back into it. Changing either one retires every link already sent: those land on
 * the neutral page and change nothing, and the switch in Your account still works.
 *
 * Only alert emails carry it (lib/notifications/email-deliver.ts). Receipts, invoices,
 * sign-in links, security and support mail are not optional and have no such link.
 */

const PURPOSE = "alert-emails-off";
const KEY_LABEL = "fleetwise:email-link-key:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A value `vercel pull` wrote in place of a secret it could not decrypt is not a secret. */
function real(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v && !/^\[.*\]$/.test(v) ? v : null;
}

function linkKey(): Buffer | null {
  const own = real(process.env.EMAIL_LINK_SECRET);
  if (own) return Buffer.from(own, "utf8");
  const service = real(process.env.SUPABASE_SERVICE_ROLE_KEY);
  return service ? createHmac("sha256", service).update(KEY_LABEL).digest() : null;
}

function sign(key: Buffer, userId: string): string {
  return createHmac("sha256", key).update(`${PURPOSE}\n${userId}`).digest("base64url");
}

/** The signature for this person, or null when there is no key to sign with. */
export function unsubscribeSignature(userId: string): string | null {
  const id = userId.toLowerCase();
  const key = linkKey();
  return key && UUID.test(id) ? sign(key, id) : null;
}

/**
 * Whether `signature` was made for `userId`. Compared in constant time, and only once the
 * lengths match, because `timingSafeEqual` throws on unequal lengths and a truncated
 * signature must be a plain "no", not an error page.
 */
export function verifyUnsubscribe(userId: string | null | undefined, signature: string | null | undefined): boolean {
  const id = (userId ?? "").toLowerCase();
  const sent = signature ?? "";
  if (!UUID.test(id) || !sent) return false;
  const key = linkKey();
  if (!key) return false;
  const want = Buffer.from(sign(key, id), "utf8");
  const got = Buffer.from(sent, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The two addresses for one person: the page a person opens from the footer (it asks before
 * it changes anything, because mail scanners open links), and the address mail providers
 * POST to for one-click unsubscribe (RFC 8058). Null without a key or a site address.
 */
export function unsubscribeLinks(base: string, userId: string): { page: string; oneClick: string } | null {
  const signature = unsubscribeSignature(userId);
  if (!signature) return null;
  const query = `u=${encodeURIComponent(userId.toLowerCase())}&s=${encodeURIComponent(signature)}`;
  return { page: `${base}/unsubscribe?${query}`, oneClick: `${base}/unsubscribe/one-click?${query}` };
}

/** Headers that let a mail app offer its own unsubscribe button, posting to `oneClick`. */
export function unsubscribeHeaders(oneClick: string): Record<string, string> {
  return { "List-Unsubscribe": `<${oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/** Switch this person's alert emails off, through the service client. Call only after `verifyUnsubscribe`. */
export async function turnOffAlertEmails(svc: Pick<SupabaseClient, "from">, userId: string): Promise<{ ok: boolean }> {
  const { error } = await svc.from("users").update({ notify_email: false }).eq("id", userId.toLowerCase());
  return { ok: !error };
}
