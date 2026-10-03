import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { AUDIO_CONSENT_VERSION } from "@/lib/assistant/transcription";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** `audio`: the person accepted the v2 text, covering the recording and machine names. */
const schema = z.object({ allow: z.boolean(), audio: z.boolean().optional() });
const CONSENT_COLUMNS = "ai_processing_opt_in, ai_processing_opted_in_at, ai_processing_consent_version, ai_processing_withdrawn_at";

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
    .select(CONSENT_COLUMNS)
    .single();
  if (error || !data) return NextResponse.json({ error: "consent_update_failed" }, { status: 400, headers });
  if (!parsed.data.allow || !parsed.data.audio || data.ai_processing_consent_version === AUDIO_CONSENT_VERSION) {
    return NextResponse.json(data, { headers });
  }

  // Opting in stamps the text-only v1 (an older build may still be live and show only
  // that text). Extending ACTIVE consent to v2 is the one further change the trigger
  // allows, and it re-stamps the time itself; see 20261003090000.
  const extended = await supabase
    .from("users")
    .update({ ai_processing_consent_version: AUDIO_CONSENT_VERSION })
    .eq("id", profile.id)
    .select(CONSENT_COLUMNS)
    .single();
  if (extended.error || !extended.data || extended.data.ai_processing_consent_version !== AUDIO_CONSENT_VERSION) {
    return NextResponse.json({ error: "consent_update_failed" }, { status: 400, headers });
  }
  return NextResponse.json(extended.data, { headers });
}
