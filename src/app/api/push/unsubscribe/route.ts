import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remove the caller's Web-Push subscription for a given endpoint (soft delete, RLS-scoped). */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  if (!body.endpoint) return NextResponse.json({ error: "missing-endpoint" }, { status: 400 });

  const supabase = await createClient();
  const { error } = await supabase
    .from("push_subscriptions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("endpoint", body.endpoint)
    .eq("user_id", profile.id)
    .is("deleted_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
