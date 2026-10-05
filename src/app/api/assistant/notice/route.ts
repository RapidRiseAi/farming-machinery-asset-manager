import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The AI notice's two buttons. "Got it" keeps AI help on (the default, founder decision
 * 10); "Switch off" turns it off. Either way the person has now been told, which the
 * database records at its own time and lets only that person record
 * (supabase/migrations/20261004095000). Someone who had switched AI off stays off
 * (`withdrawn`): dismissing a notice never overrides a no. Runs as the signed-in user,
 * never the service role.
 */

const HEADERS = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" } as const;
const bodySchema = z.object({ keepOn: z.boolean() });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const context = await getAssistantContext();
  if (!context) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: HEADERS });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: HEADERS });

  const { data, error } = await context.supabase.rpc("ai_notice_ack", { p_keep_on: parsed.data.keepOn });
  if (error || !data) return NextResponse.json({ error: "notice_failed" }, { status: 500, headers: HEADERS });
  const value = data as { ai_on?: boolean; withdrawn?: boolean; notice_seen_at?: string | null };
  return NextResponse.json(
    { aiOn: Boolean(value.ai_on), withdrawn: Boolean(value.withdrawn), noticeSeenAt: value.notice_seen_at ?? null },
    { headers: HEADERS },
  );
}
