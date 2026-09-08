import { after, NextResponse } from "next/server";

import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/billing/config";
import { getSaasProvider } from "@/lib/billing/service";
import { handlePaystackWebhook } from "@/lib/billing/webhook";
import { sendDueReceipts } from "@/lib/billing/receipt";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Paystack's webhook endpoint.
 *
 * This handler deliberately does almost nothing: it holds the RAW bytes, refuses a body
 * that is obviously not an event, and hands everything else to
 * `src/lib/billing/webhook.ts`, where the rules can be exercised by a unit test with no
 * network and no database.
 *
 * `runtime = "nodejs"` is required, not preferred: the signature is an HMAC-SHA512
 * compared with `crypto.timingSafeEqual`, and the raw body must survive unmodified.
 *
 * ── Why the body is read with `text()` and never `json()` ─────────────────────
 * The signature covers the exact bytes Paystack sent. `request.json()` parses and
 * discards them, and re-serialising to check a signature is a way of checking a
 * signature over a body nobody sent. So: `text()`, then verify, then parse.
 *
 * ── Authentication ────────────────────────────────────────────────────────────
 * The signature IS the authentication. There is no session, no CSRF check and no origin
 * check here, because the caller is Paystack's server and holds no cookie. Everything
 * downstream of the signature check treats the payload as untrusted anyway: the event is
 * re-verified server-to-server before one cent is recorded.
 *
 * ── Paystack's IP allowlist, and why it is NOT enforced here ──────────────────
 * Paystack publishes three source addresses (52.31.139.75, 52.49.173.169, 52.214.14.220).
 * We deliberately do not check them, and the reason is worth writing down so nobody adds
 * it later believing it was an oversight:
 *
 *  - the HMAC signature is cryptographically stronger than an IP match, and a request
 *    that passes it could not have been forged by someone merely sitting at the right
 *    address;
 *  - behind Vercel's proxy the connecting address is a FORWARDED HEADER, which is
 *    attacker-influenced and therefore worthless as an authentication factor — enforcing
 *    it would add a check that looks like security and is not;
 *  - Paystack changing an address would silently break every payment, with the failure
 *    landing as "no webhooks are arriving", which is the hardest kind to notice.
 *
 * It belongs in the docs as an optional network-layer control the founder can apply at
 * the edge (a firewall rule in front of the app), not as a branch in this file.
 *
 * ── Return 200 for anything we recorded ───────────────────────────────────────
 * Paystack expects `200 OK` and retries anything else every 3 minutes for the first four
 * attempts and then hourly for 72 hours. So a 500 returned on a BUSINESS-RULE refusal —
 * an amount that did not match, a reference we do not know — buys three days of duplicate
 * deliveries that cannot possibly help, because the dedupe key means every one of them
 * does nothing. Non-2xx is reserved for the cases where we recorded NOTHING and a
 * redelivery is genuinely the fix.
 *
 * Nothing here logs the body, the signature header, an email or an authorization code.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Refuse an oversized body BEFORE reading it into memory where we can. `content-length`
  // is the sender's claim, so it is a cheap early exit and not the check that counts —
  // the byte-length check inside the handler is the one that decides.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "unreadable body" }, { status: 400 });
  }

  const signature = request.headers.get("x-paystack-signature");

  try {
    const supabase = createServiceClient();
    const provider = await getSaasProvider();
    const result = await handlePaystackWebhook({ rawBody, signature, supabase, provider });

    // Email the receipt AFTER answering. Paystack wants a prompt 200 and retries for
    // three days if it does not get one; rendering a PDF and waiting on a mail provider
    // is not work to keep it waiting for. `after()` runs once the response is sent, in
    // the same invocation.
    //
    // Safe to call unconditionally: it sends only for invoices that are paid and not yet
    // receipted, and the claim means the nightly pass cannot double it up.
    if (result.status === 200) {
      after(async () => {
        try {
          await sendDueReceipts(supabase, { limit: 5 });
        } catch (err) {
          captureError(err, { where: "billing:webhook:receipt" });
        }
      });
    }

    return NextResponse.json({ ok: result.status === 200, outcome: result.outcome }, {
      status: result.status,
    });
  } catch (err) {
    // A throw here means we cannot say whether the event was recorded, so this is the one
    // place a non-2xx genuinely helps: Paystack retries, and the idempotency key makes a
    // retry harmless if it turns out the row did land.
    //
    // The error is reported WITHOUT the payload, the signature or the reference: an error
    // report is the last place a charging credential or a customer's email should surface.
    captureError(err, { where: "billing:webhook" });
    return NextResponse.json({ ok: false, error: "unhandled" }, { status: 500 });
  }
}

/** Anything but a POST is not an event. Answered plainly rather than 404'd. */
export async function GET() {
  return NextResponse.json({ ok: false, error: "method not allowed" }, { status: 405 });
}
