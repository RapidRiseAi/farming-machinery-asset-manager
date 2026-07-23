import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Register (or refresh) the caller's Web-Push subscription for their farm. The row is
 * written as the signed-in user under RLS (own-user policy, 0262). Re-subscribing the same
 * endpoint replaces the previous row (soft-delete + insert) so keys stay current.
 */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active || !profile.farm_id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; ua?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "missing-subscription" }, { status: 400 });
  }

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
    ua: body.ua ?? request.headers.get("user-agent") ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
