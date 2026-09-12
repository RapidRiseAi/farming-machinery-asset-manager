import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { sameOrigin } from "@/lib/security/same-origin";
import { validateWebPushSubscription } from "@/lib/push/subscription-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Register (or refresh) the caller's Web-Push subscription for their farm. The row is
 * written as the signed-in user under RLS (own-user policy, 0262). Re-subscribing the same
 * endpoint replaces the previous row (soft-delete + insert) so keys stay current.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const profile = await getProfile();
  if (!profile || !profile.active || !profile.farm_id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "missing-subscription" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const keys = input.keys && typeof input.keys === "object" && !Array.isArray(input.keys)
    ? input.keys as Record<string, unknown>
    : {};
  const subscription = validateWebPushSubscription({
    endpoint: input.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  });
  if (!subscription) return NextResponse.json({ error: "invalid-subscription" }, { status: 400 });
  const { endpoint, p256dh, auth } = subscription;
  const uaSource = typeof input.ua === "string" ? input.ua : request.headers.get("user-agent");
  const ua = uaSource?.slice(0, 512) || null;

  const supabase = await createClient();
  // Clear any prior live row for this endpoint (endpoint is globally unique), then insert.
  await supabase
    .from("push_subscriptions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("endpoint", endpoint)
    .is("deleted_at", null);

  const { error } = await supabase.from("push_subscriptions").insert({
    farm_id: profile.farm_id,
    user_id: profile.id,
    endpoint,
    p256dh,
    auth,
    ua,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
