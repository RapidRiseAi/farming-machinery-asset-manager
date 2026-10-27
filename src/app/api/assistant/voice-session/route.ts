import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { openVoiceSession } from "@/lib/ai-usage/ledger";
import { claimRequest } from "@/lib/request-claim";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Opens another metered stretch of Azure Speech use (docs/AI_USAGE.md) when the one the
 * browser holds is full or old: holds budget for up to maxAudioMs of recognition and
 * maxCharacters of synthesised speech (less when the month has less left), and returns the
 * session the browser reports its use against. The first session comes with the Azure
 * token itself (speech-token). Azure cannot enforce a session (its token works on the
 * whole resource), so the database clamps every report to the session's maximum, and
 * settles a session never reported at its full maximum.
 *
 * Once per request id (request_claims): an open whose answer was lost on farm signal left a
 * session the browser never heard of, settled at its full maximum, and the browser's next
 * attempt opened a second. The browser keeps the id until it has a session, so a replay
 * gets the session already held instead of another hold.
 */

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } as const;
const fail = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, ...extra }, { status, headers: HEADERS });

const bodySchema = z.object({
  maxAudioMs: z.number().int().min(0).max(120_000),
  maxCharacters: z.number().int().min(0).max(4_000),
  clientVersion: z.string().min(1).max(40),
  requestId: z.uuid().optional(),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("forbidden", 403);
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", 403);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("bad_request", 400);

  const { requestId, ...sizes } = parsed.data;
  const claim = await claimRequest(await createClient(), requestId ?? null, "assistant:voice-session");
  if (claim.state === "done") {
    try {
      return NextResponse.json(JSON.parse(claim.outcome), { headers: HEADERS });
    } catch {
      return fail("unavailable", 503);
    }
  }
  if (claim.state === "running") return fail("still_opening", 409);

  let session: Awaited<ReturnType<typeof openVoiceSession>>;
  try {
    session = await openVoiceSession({ farmId: context.farmId, userId: context.profile.id, ...sizes, source: "meter" });
  } catch (error) {
    await claim.release();
    throw error;
  }
  if (session.ok) {
    await claim.finish(JSON.stringify(session));
    return NextResponse.json(session, { headers: HEADERS });
  }
  // Nothing was held: the next attempt must be free to try again.
  await claim.release();
  if (session.reason === "farm_limit" || session.reason === "member_limit") {
    return fail("ai_limit_reached", 402, { scope: session.reason === "farm_limit" ? "farm" : "member" });
  }
  if (session.reason === "voice_off") return fail("voice_off", 403);
  if (session.reason === "not_member") return fail("forbidden", 403);
  return fail("unavailable", 503);
}
