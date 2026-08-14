import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const schema = z.object({ allow: z.boolean() });

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store, max-age=0" };
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400, headers });

  // Granting consent is useful only when this person may use the selected farm's voice
  // feature. Withdrawal is a privacy right and remains available after a plan downgrade
  // (or to a role that no longer has assistant access).
  const context = parsed.data.allow ? await getAssistantContext() : null;
  const profile = context?.profile ?? (await getProfile());
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers });
  if (parsed.data.allow && !context) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  }
  const supabase = context?.supabase ?? (await createClient());

  // The DB trigger accepts only self-consent and stamps its own evidence/version. The
  // browser supplies one boolean; it cannot forge the timestamp or consent wording.
  const { data, error } = await supabase
    .from("users")
    .update({ ai_processing_opt_in: parsed.data.allow })
    .eq("id", profile.id)
    .select("ai_processing_opt_in, ai_processing_opted_in_at, ai_processing_consent_version, ai_processing_withdrawn_at")
    .single();
  if (error || !data) return NextResponse.json({ error: "consent_update_failed" }, { status: 400, headers });
  return NextResponse.json(data, { headers });
}
