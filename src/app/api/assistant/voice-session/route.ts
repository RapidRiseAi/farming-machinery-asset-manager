import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { openVoiceSession } from "@/lib/ai-usage/ledger";

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
 */

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } as const;
const fail = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: code, ...extra }, { status, headers: HEADERS });

const bodySchema = z.object({
  maxAudioMs: z.number().int().min(0).max(120_000),
  maxCharacters: z.number().int().min(0).max(4_000),
  clientVersion: z.string().min(1).max(40),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail("forbidden", 403);
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", 403);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("bad_request", 400);

  const session = await openVoiceSession({ farmId: context.farmId, userId: context.profile.id, ...parsed.data, source: "meter" });
  if (session.ok) return NextResponse.json(session, { headers: HEADERS });
  if (session.reason === "farm_limit" || session.reason === "member_limit") {
    return fail("ai_limit_reached", 402, { scope: session.reason === "farm_limit" ? "farm" : "member" });
  }
  if (session.reason === "voice_off") return fail("voice_off", 403);
  if (session.reason === "not_member") return fail("forbidden", 403);
  return fail("unavailable", 503);
}
