import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Switches AI help on or off for the signed-in person (founder decision 10: on by default
 * after the notice, and always theirs to switch off). `notice: true` comes from the
 * current app, whose switch sits under the notice's own text, so switching on there also
 * records the notice as seen. The previous build sends `audio` instead (accepted and
 * ignored) and never `notice`: its switch-on is stamped with its own card's version and AI
 * stays refused until the person sees the notice in the current app.
 */
const schema = z.object({ allow: z.boolean(), notice: z.boolean().optional(), audio: z.boolean().optional() });
const CONSENT_COLUMNS =
  "ai_processing_opt_in, ai_processing_opted_in_at, ai_processing_consent_version, ai_processing_withdrawn_at, ai_notice_seen_at";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store, max-age=0" };
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400, headers });

  // Switching on is useful only when this person may use the selected farm's assistant.
  // Switching off is a privacy right and stays available after a plan downgrade, or to a
  // role that no longer has assistant access.
  const context = parsed.data.allow ? await getAssistantContext() : null;
  const profile = context?.profile ?? (await getProfile());
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers });
  if (parsed.data.allow && !context) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  }
  const supabase = context?.supabase ?? (await createClient());

  // The trigger accepts only the person's own change and stamps its own evidence, version
  // and notice time; the browser supplies one boolean.
  const { data, error } = await supabase
    .from("users")
    .update(parsed.data.allow
      ? parsed.data.notice
        ? { ai_processing_opt_in: true, ai_notice_seen_at: new Date().toISOString() }
        : { ai_processing_opt_in: true }
      : { ai_processing_opt_in: false })
    .eq("id", profile.id)
    .select(CONSENT_COLUMNS)
    .single();
  if (error || !data) return NextResponse.json({ error: "consent_update_failed" }, { status: 400, headers });
  return NextResponse.json(data, { headers });
}
