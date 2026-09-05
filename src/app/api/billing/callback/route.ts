import { NextResponse } from "next/server";

import { billingSiteUrl } from "@/lib/billing/config";
import { getAttemptByReference, getSaasProvider } from "@/lib/billing/service";
import { accessibleFarms, effectiveFarmRole, getProfile } from "@/lib/auth";
import { captureError } from "@/lib/observability";

/**
 * Where Paystack returns the customer after a hosted checkout.
 *
 * ── This route is INFORMATIONAL. It grants nothing and marks nothing paid. ────
 * That is the whole design, and it is not caution for its own sake: the customer's
 * browser is the one place in this flow an attacker fully controls. Anyone can open
 * `/api/billing/callback?reference=…` with any string in it, from any tab, at any time.
 * So this route never settles an attempt, never writes a payment, never touches
 * entitlement, and never stores a card.
 *
 * What actually records a payment is one of exactly two things, both server-to-server:
 * the webhook (signature-checked, then re-verified), and the nightly reconciler
 * (verifying our own reference). This route only reads what happened so the page it
 * redirects to can say something true, and it only asks about a reference WE minted for a
 * farm THIS person can administer — otherwise the endpoint would be a free oracle for
 * "does this Paystack reference exist and what is it worth", answered on our secret key.
 *
 * The redirect target is fixed (`/billing`) and built from `NEXT_PUBLIC_SITE_URL`. Nothing
 * a caller supplies reaches it, so there is no path here for an open redirect.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the billing page renders. Deliberately about the CHECKOUT, not about entitlement. */
type CheckoutState = "paid" | "pending" | "failed" | "unknown";

function back(request: Request, state: CheckoutState): NextResponse {
  const origin = billingSiteUrl() ?? new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/billing?checkout=${state}`, 303);
}

export async function GET(request: Request) {
  const reference = new URL(request.url).searchParams.get("reference");

  // No session: send them to /billing, which bounces to login and back. Saying anything
  // about the reference to an unauthenticated caller would be the oracle described above.
  const profile = await getProfile();
  if (!profile) return back(request, "unknown");

  if (!reference || reference.trim() === "") return back(request, "unknown");

  try {
    // Deliberately the RLS-free client is NOT used for the authorization decision: the
    // attempt is looked up as the service role (a farm owner cannot read another farm's
    // attempts anyway), and then the caller's own role on THAT farm is checked before a
    // single word about it is returned.
    const { createServiceClient } = await import("@/lib/supabase/service");
    const supabase = createServiceClient();

    const attempt = await getAttemptByReference(supabase, reference.trim());
    if (!attempt) return back(request, "unknown");

    if (profile.role !== "rr_admin") {
      const farms = await accessibleFarms(profile);
      if (!farms.some((f) => f.id === attempt.farm_id)) return back(request, "unknown");
    }
    const role = await effectiveFarmRole(attempt.farm_id, profile);
    if (role !== "owner" && role !== "rr_admin") return back(request, "unknown");

    // Already settled by the webhook, which is the normal case — Paystack's event usually
    // beats the browser back. Report what we hold rather than making another API call.
    if (attempt.status === "succeeded") return back(request, "paid");
    if (attempt.status === "failed") return back(request, "failed");

    const provider = await getSaasProvider();
    if (!provider || !provider.enabled) return back(request, "pending");

    const verified = await provider.verifyTransaction(attempt.attempt_ref);
    if (!verified.ok) return back(request, "pending");

    switch (verified.transaction.status) {
      case "success":
        // Read as "Paystack says it went through" — NOT as "we have credited it". The
        // page says the receipt is on its way; the webhook or the reconciler is what
        // actually moves the invoice, and this route stays out of it deliberately.
        return back(request, "paid");
      case "failed":
        return back(request, "failed");
      case "abandoned":
        return back(request, "failed");
      default:
        return back(request, "pending");
    }
  } catch (err) {
    captureError(err, { where: "billing:callback" });
    return back(request, "pending");
  }
}
