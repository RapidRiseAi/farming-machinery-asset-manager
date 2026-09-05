import { NextResponse } from "next/server";

import { billingSiteUrl } from "@/lib/billing/config";
import { beginCheckout, billingContactEmail } from "@/lib/billing/service";
import { accessibleFarms, currentFarmId, effectiveFarmRole, getProfile } from "@/lib/auth";
import { captureError } from "@/lib/observability";
import { sameOrigin } from "@/lib/security/same-origin";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Start a hosted Paystack checkout for a farm's open invoice.
 *
 * ── What this route is careful about ─────────────────────────────────────────
 *
 *  - POST only. A GET that starts a payment is a payment anything can trigger with an
 *    `<img>` tag.
 *  - The role is re-checked HERE, server-side, against the farm being paid for. Owner or
 *    Rapid Rise admin, and nobody else: managers, mechanics, operators and — emphatically
 *    — linked contractors have no business in a farm's subscription. Hiding the button is
 *    not a control.
 *  - The origin is checked, because this endpoint authenticates with a cookie and would
 *    otherwise be replayable from any other site the owner has open.
 *  - The callback URL is built from `NEXT_PUBLIC_SITE_URL` (`billingSiteUrl`), never from
 *    the `Host` header. A `Host` value is attacker-controlled, and a payment flow is the
 *    single most credible place to send somebody through an open redirect.
 *  - The reference is minted and PERSISTED before Paystack is contacted — that happens
 *    inside `beginCheckout`, which is shared with the owner's server action so there is
 *    one sequence and not two that can drift.
 *
 * A deferred or disabled adapter comes back as an error CODE the billing page renders as
 * a translated sentence. It is never a 500: "we have not switched payments on yet" is a
 * state, not a fault.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounce back to the billing page with a code `src/lib/errors.ts` can translate. */
function bounce(request: Request, code: string): NextResponse {
  const origin = billingSiteUrl() ?? new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/billing?error=${encodeURIComponent(code)}`, 303);
}

export async function POST(request: Request) {
  // Cookie-authenticated and state-changing, so an exact origin match is required. The
  // configured site origin is checked as well as the request's own, so a preview
  // deployment cannot start a payment against production's cookies.
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const configured = billingSiteUrl();
  const sent = request.headers.get("origin");
  if (configured && sent && sent !== configured) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let requestedFarm: string | null = null;
  try {
    const form = await request.formData();
    requestedFarm = String(form.get("farm_id") ?? "").trim() || null;
  } catch {
    requestedFarm = null;
  }

  const farmId = requestedFarm ?? (await currentFarmId(profile));
  if (!farmId) return bounce(request, "no-farm");

  // A farm id arriving in the body is a request, not a fact. It has to be one this person
  // actually reaches before the role on it means anything.
  if (requestedFarm && profile.role !== "rr_admin") {
    const farms = await accessibleFarms(profile);
    if (!farms.some((f) => f.id === requestedFarm)) return bounce(request, "forbidden");
  }

  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "rr_admin") return bounce(request, "forbidden");

  try {
    const supabase = createServiceClient();
    // The farm's OWNER is the billing contact even when Rapid Rise pressed the button, so
    // the transaction and the card that comes out of it belong to the farmer.
    const email = await billingContactEmail(supabase, farmId, profile.email);
    const started = await beginCheckout(supabase, {
      farmId,
      email,
      userId: profile.id,
    });
    if (!started.ok) return bounce(request, started.code);

    // A `fetch` caller gets JSON; a plain form post gets the redirect it is expecting.
    // `beginCheckout` has already refused anything that is not an https Paystack URL, so
    // neither branch can hand the browser somewhere else.
    if ((request.headers.get("accept") ?? "").includes("application/json")) {
      return NextResponse.json({ ok: true, url: started.url, reference: started.reference });
    }
    return NextResponse.redirect(started.url, 303);
  } catch (err) {
    captureError(err, { where: "billing:checkout" });
    return bounce(request, "billing-checkout-failed");
  }
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
