/**
 * SaaS-billing configuration — read LAZILY, fail CLOSED.
 *
 * Every value here is read from `process.env` INSIDE the function that needs it, never
 * at module scope. Two reasons, both learned the hard way in this codebase:
 *
 *  - `next build` runs with no secrets. A module-scope read that throws (or that caches
 *    `undefined`) turns a missing key into a build failure or, worse, into a process
 *    that believes billing is unconfigured for the rest of its life because the first
 *    import happened before the environment was populated.
 *  - The kill switch has to be answerable at the moment somebody presses a button, not
 *    at the moment a bundle was assembled.
 *
 * FAIL CLOSED means: a missing or unreadable value is "not configured", and "not
 * configured" is a returned reason, never a thrown error. Nothing in this file can stop
 * the rest of FleetWise from working, and nothing in it can accidentally enable a charge.
 *
 * NOTHING HERE EVER RETURNS OR LOGS THE SECRET. `paystackConfig()` hands the key to the
 * adapter and to nobody else; `redact()` exists so a provider's own words can be stored
 * on an attempt row without carrying a credential or a customer's email address with it.
 *
 * SCOPE: this is farms paying Rapid Rise for FleetWise. It has no relationship to
 * `src/lib/payments/*` (the dormant partner-side PayFast seam) and must never read a
 * `PAYFAST_*` variable.
 */

/** Where Paystack's REST API lives. Overridable per-adapter for tests only. */
export const PAYSTACK_BASE_URL = "https://api.paystack.co";

/** The only currency this ledger deals in — mirrors the `= 'ZAR'` check constraints. */
export const BILLING_CURRENCY = "ZAR";

/**
 * Refuse to hash a webhook body larger than this. Paystack's events are a few kilobytes;
 * a megabyte of body is either a bug or somebody probing for a way to make us burn CPU
 * on an HMAC before we have decided we trust them.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export type PaystackConfig =
  | { ok: true; secretKey: string; siteUrl: string | null }
  | { ok: false; reason: string };

/** Trimmed environment read. An unset variable and a whitespace-only one are the same. */
function env(name: string): string {
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** `BILLING_PROVIDER`, lower-cased. Unset means the no-op adapter. */
export function billingProvider(): string {
  return (env("BILLING_PROVIDER") || "noop").toLowerCase();
}

export function providerIsPaystack(): boolean {
  return billingProvider() === "paystack";
}

/**
 * The origin every customer-facing billing URL is built from.
 *
 * Deliberately `NEXT_PUBLIC_SITE_URL` and deliberately reduced to its ORIGIN: a callback
 * URL assembled from the `Host` header is an open redirect wearing a payment flow as a
 * disguise, and a configured value carrying a stray path would silently double it up.
 * Returns null rather than a guess when it is unset or unparseable.
 */
export function billingSiteUrl(): string | null {
  const raw = env("NEXT_PUBLIC_SITE_URL");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * An absolute callback URL for a path inside this app. Null when the site URL is not
 * configured or the path is not a plain single-slash absolute path — the same rule
 * `safePath()` applies elsewhere, because `//evil.com` and `/\evil.com` are both
 * scheme-relative and both leave our origin.
 */
export function billingCallbackUrl(path: string): string | null {
  const origin = billingSiteUrl();
  if (!origin) return null;
  if (!path.startsWith("/")) return null;
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  return `${origin}${path}`;
}

/**
 * The provider credential, or a plain reason it is unavailable.
 *
 * `ok:false` is not an error condition — it is the resting state of a fresh clone, of
 * CI, and of production until the founder switches billing on.
 */
export function paystackConfig(): PaystackConfig {
  if (!providerIsPaystack()) {
    return { ok: false, reason: "billing provider is not paystack" };
  }
  const secretKey = env("PAYSTACK_SECRET_KEY");
  if (!secretKey) {
    return { ok: false, reason: "billing provider key is not configured" };
  }
  return { ok: true, secretKey, siteUrl: billingSiteUrl() };
}

/** True when a real provider is wired. Says nothing about whether it may charge. */
export function billingConfigured(): boolean {
  return paystackConfig().ok;
}

/**
 * The second half of the two-part safety switch.
 *
 * Compared EXACTLY against `"true"`, case-sensitively. `TRUE`, `1` and `yes` all leave
 * charging OFF — which is the safe direction for a typo in a hosting dashboard to fail
 * in. A charge that does not happen is a support ticket; a charge that happens because
 * somebody capitalised a word is money taken from a farmer by accident.
 */
export function chargingEnabled(): boolean {
  if (!billingConfigured()) return false;
  return env("BILLING_CHARGING_ENABLED") === "true";
}

/**
 * Which Paystack environment the configured key belongs to, WITHOUT revealing the key.
 * Useful for a banner that says "test mode" so nobody demonstrates a live charge by
 * accident. Null when nothing is configured.
 */
export function paystackKeyMode(): "test" | "live" | "unknown" | null {
  const cfg = paystackConfig();
  if (!cfg.ok) return null;
  if (cfg.secretKey.startsWith("sk_test_")) return "test";
  if (cfg.secretKey.startsWith("sk_live_")) return "live";
  // Not an error: Paystack has changed key prefixes before, and refusing an unrecognised
  // key would break billing over a cosmetic detail. We simply decline to guess.
  return "unknown";
}

/** How much of a provider message we are willing to keep. Longer is never more useful. */
const MAX_REASON_CHARS = 300;

/**
 * Strip anything that must never reach a log line, an error report, a support
 * screenshot or a `failure_reason` column, then truncate.
 *
 * Four classes, in order of how badly they would hurt:
 *   1. the configured secret key itself, matched literally;
 *   2. any `sk_test_` / `sk_live_` key shape, in case a different key is quoted back;
 *   3. a Paystack authorization code (`AUTH_…`) — a charging credential, not a reference;
 *   4. an email address — POPIA personal data, and the thing Paystack is most likely to
 *      quote back at us in a "customer not found" message.
 *
 * This is defence in depth, not permission to be careless: the adapter does not put any
 * of these into a message in the first place.
 */
export function redact(text: string): string {
  let out = String(text ?? "");
  const cfg = paystackConfig();
  if (cfg.ok && cfg.secretKey.length >= 8) {
    out = out.split(cfg.secretKey).join("[redacted]");
  }
  out = out.replace(/\bsk_(?:test|live)_[A-Za-z0-9]+/g, "sk_[redacted]");
  out = out.replace(/\bAUTH_[A-Za-z0-9]+/g, "AUTH_[redacted]");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_REASON_CHARS ? `${out.slice(0, MAX_REASON_CHARS)}…` : out;
}
