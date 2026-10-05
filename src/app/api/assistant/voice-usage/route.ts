import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { reportVoiceSession } from "@/lib/ai-usage/ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Cumulative use of one voice session, from the browser: shortly after each use, every 30
 * seconds while in use, a final report when the session ends, and a navigator.sendBeacon
 * when the page is hidden or closes (which arrives as text/plain, so the body is read as
 * text and parsed). Reports are idempotent and only ever raise the counters; the database
 * clamps them. 410 means the session was already closed (by a final report, or by the
 * nightly sweep under a tab left open): the browser drops it and opens another.
 */

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  audioMs: z.number().int().min(0).max(120_000),
  audioFixedMs: z.number().int().min(0).max(120_000),
  characters: z.number().int().min(0).max(4_000),
  final: z.boolean(),
});

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const context = await getAssistantContext();
  if (!context) return new NextResponse(null, { status: 403 });
  let raw: unknown = null;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const outcome = await reportVoiceSession({ userId: context.profile.id, ...parsed.data });
  const status = outcome === "ok" ? 204 : outcome === "closed" ? 410 : 409;
  return new NextResponse(null, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
