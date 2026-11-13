import "server-only";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import { captureError } from "@/lib/observability";
import { takeKeyedRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/security/client-ip";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * A brake on guessing passwords, and on sending sign-in emails to somebody else's inbox.
 *
 * The audit of 12 November 2026 found twelve wrong passwords in a row went through at full
 * speed. Each attempt is now counted twice, in the database so every server instance shares
 * the count (20261113090000): against the address, and against the caller's IP. Over either
 * limit the action says "too many attempts" and never calls Supabase Auth. The same answer
 * comes back whether or not the address has an account, so the limit is not a way to learn
 * who is a customer.
 *
 * == Fails OPEN, on purpose =================================================
 * If the counter cannot be read (the database is down, the migration is not applied yet)
 * the attempt goes through and the fault is reported. Failing closed would turn one outage
 * of a guard into every customer locked out of their account at once. What still stands in
 * that case: Supabase Auth checks the password and keeps its own limits, and the bot check
 * (lib/security/turnstile.ts) is unaffected. The same reasoning, and the same direction, as
 * the sign-up slot and the dictation limits.
 *
 * == What is stored =========================================================
 * Neither the address nor the IP: each is hashed (SHA-256, lower-cased, namespaced) before
 * it leaves this file, and the database refuses a subject that is not a 64-character digest.
 * Rows last a day at most.
 */

/** "password" for a password sign-in; "email" for the two that send an email (link, reset). */
export type SignInKind = "password" | "email";

export const SIGN_IN_LIMITS = {
  /** Per address and kind. Eight is more than anybody who knows their password ever needs. */
  address: { windowSeconds: 15 * 60, max: 8 },
  /** Per IP, every kind together. Generous, because a farm office shares one connection. */
  ip: { windowSeconds: 15 * 60, max: 30 },
} as const;

/** The opaque key for an address or an IP. Same input, same key; never reversible here. */
export function limiterSubject(value: string): string {
  return createHash("sha256").update(`fleetwise:sign-in:${value.trim().toLowerCase()}`).digest("hex");
}

/**
 * Count one attempt. True means carry on. `svc` is the service client: the key is chosen
 * here, by the server, never by the caller.
 */
export async function takeSignInAttempt(
  svc: Pick<SupabaseClient, "rpc">,
  input: { kind: SignInKind; email: string; ip: string | null },
): Promise<boolean> {
  const takes = [
    takeKeyedRateLimit(
      svc,
      `signin_${input.kind}`,
      limiterSubject(input.email),
      SIGN_IN_LIMITS.address.windowSeconds,
      SIGN_IN_LIMITS.address.max,
    ),
  ];
  // No IP, no IP limit. Putting every unknown caller in one bucket would let a single missing
  // header lock everybody out at once, which is exactly the outage this must not cause; the
  // address limit still applies.
  if (input.ip) {
    takes.push(
      takeKeyedRateLimit(svc, "signin_ip", limiterSubject(input.ip), SIGN_IN_LIMITS.ip.windowSeconds, SIGN_IN_LIMITS.ip.max),
    );
  }
  return (await Promise.all(takes)).every((r) => r.allowed);
}

/**
 * For a sign-in action, after the bot check and before any call to Supabase Auth:
 * "signin-busy" when a limit is spent, otherwise null.
 */
export async function signInLimit(kind: SignInKind, email: string): Promise<"signin-busy" | null> {
  let svc: Pick<SupabaseClient, "rpc">;
  try {
    svc = createServiceClient();
  } catch (err) {
    // No service key in this environment: open, like any other fault of the counter.
    captureError(err, { where: "rate_limit:signin", level: "warning" });
    return null;
  }
  const ip = clientIp(await headers());
  return (await takeSignInAttempt(svc, { kind, email, ip })) ? null : "signin-busy";
}
