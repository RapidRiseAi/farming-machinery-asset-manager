import "server-only";

import { headers } from "next/headers";

import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { localeOf, type Lang, type Locale } from "@/lib/i18n";
import { captureError } from "@/lib/observability";
import { clientIp } from "@/lib/security/client-ip";

/**
 * Cloudflare Turnstile: the bot check on sign-up, sign-in and the partner application.
 *
 * == Off until both keys exist ==============================================
 * With NEXT_PUBLIC_TURNSTILE_SITE_KEY or TURNSTILE_SECRET_KEY unset, nothing changes: no
 * script loads, no widget renders, every action behaves exactly as before, and /api/health
 * warns `captcha_not_configured`. The page decides (`turnstileWidget`), on the server, so a
 * site key on its own never puts a widget on screen that the server cannot check.
 *
 * == Closed once it is on ===================================================
 * With both set, the form posts Cloudflare's token and the action checks it here before any
 * database or Auth call. A missing or refused token, or Cloudflare not answering within five
 * seconds, sends the person back with a sentence. That includes a browser with JavaScript
 * off: the widget cannot run there, so no token is posted and the submit is refused with the
 * same "tick the check again" message, which says JavaScript is needed.
 *
 * The token and the secret are never logged. What is reported is Cloudflare's own error
 * code or the HTTP status, never the request.
 */

/** The field the widget adds to the form it sits in (Turnstile's default name). */
export const TURNSTILE_FIELD = "cf-turnstile-response";
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;
/** Cloudflare's ceiling for a token. Anything longer is not one and is not sent. */
const MAX_TOKEN_LENGTH = 2048;

/** The `?error=` codes (lib/errors.ts): the person tries again, or we could not check. */
export type TurnstileRefusal = "captcha-retry" | "captcha-unavailable";

type Env = Record<string, string | undefined>;

export function turnstileConfig(env: Env = process.env): { siteKey: string; secretKey: string } | null {
  const siteKey = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  return siteKey && secretKey ? { siteKey, secretKey } : null;
}

/**
 * The widget's language. Turnstile has no Afrikaans (its list, November 2026), and English
 * is the second language of nearly everybody reading the Afrikaans screens; Dutch, the
 * nearest it has, would read as Afrikaans spelt wrong. Add `af: "af"` here if it arrives.
 */
const WIDGET_LANGUAGE: Record<Locale, string> = { en: "en", af: "en" };

/** What a page hands its widget, or null when the check is off: then render nothing. */
export function turnstileWidget(locale: Lang): { siteKey: string; language: string } | null {
  const config = turnstileConfig();
  return config ? { siteKey: config.siteKey, language: WIDGET_LANGUAGE[localeOf(locale)] } : null;
}

/** Cloudflare's codes that mean the token is no good (expired, used, absent): try again. */
const TOKEN_CODES = new Set([
  "missing-input-response",
  "invalid-input-response",
  "timeout-or-duplicate",
  "bad-request",
]);

export type TurnstileDeps = {
  env?: Env;
  /** Injected by the tests; the real `fetch` otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Where our fault or Cloudflare's is reported. Only ever handed a status or a code. */
  report?: (message: string) => void;
};

/**
 * Check a posted token with Cloudflare. Null means carry on (it passed, or the check is
 * off); otherwise the code to send the person back with. Never throws.
 */
export async function verifyTurnstile(
  token: unknown,
  remoteIp: string | null,
  deps: TurnstileDeps = {},
): Promise<TurnstileRefusal | null> {
  const config = turnstileConfig(deps.env);
  if (!config) return null;
  const report =
    deps.report ?? ((message: string) => captureError(new Error(message), { where: "turnstile", level: "warning" }));

  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) return "captcha-retry";

  const body = new URLSearchParams({ secret: config.secretKey, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  let res: Response;
  try {
    res = await fetchWithTimeout(SITEVERIFY_URL, {
      method: "POST",
      body,
      timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
      fetchImpl: deps.fetch,
    });
  } catch (err) {
    // The error's NAME only: a message can quote the request, and the request holds the secret.
    report(`siteverify unreachable (${err instanceof Error ? err.name : "unknown"})`);
    return "captcha-unavailable";
  }
  if (!res.ok) {
    report(`siteverify answered ${res.status}`);
    return "captcha-unavailable";
  }

  let result: { success?: unknown; "error-codes"?: unknown };
  try {
    result = (await res.json()) as typeof result;
  } catch {
    report("siteverify answered with something that is not JSON");
    return "captcha-unavailable";
  }
  if (result?.success === true) return null;

  const codes = Array.isArray(result?.["error-codes"])
    ? (result["error-codes"] as unknown[]).filter((c): c is string => typeof c === "string" && /^[a-z-]{1,40}$/.test(c))
    : [];
  // A wrong or missing secret, or Cloudflare's own failure, is ours to hear about, and the
  // person cannot fix it by ticking again.
  const ours = codes.filter((c) => !TOKEN_CODES.has(c));
  if (ours.length) {
    report(`siteverify refused: ${ours.join(", ")}`);
    return "captcha-unavailable";
  }
  return "captcha-retry";
}

/**
 * The check a server action runs before anything else that touches the database or Auth:
 *
 *   const captcha = await checkTurnstile(formData);
 *   if (captcha) bounce(captcha);
 */
export async function checkTurnstile(formData: FormData): Promise<TurnstileRefusal | null> {
  if (!turnstileConfig()) return null;
  return verifyTurnstile(formData.get(TURNSTILE_FIELD), clientIp(await headers()));
}
