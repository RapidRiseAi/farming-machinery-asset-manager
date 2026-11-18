import { NextResponse } from "next/server";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { assistantTurnRequestSchema } from "@/lib/assistant/request-schema";
import { runAssistantTurn } from "@/lib/assistant/run-turn";
import { respondOnce } from "@/lib/request-claim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function POST(request: Request) {
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    { kind: "error", code, message }, { status, headers: HEADERS },
  );
  if (!sameOrigin(request)) return fail("forbidden", "Request blocked.", 403);
  const parsed = assistantTurnRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("bad_request", "Check the command and try again.", 400);
  const af = parsed.data.locale === "af-ZA";
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", af
    ? "Stemassistenttoegang is nie vir hierdie plaas en rol beskikbaar nie."
    : "Voice assistant access is not available for this farm and role.", 403);
  // Once per request id (repeat-tap follow-up, BRIEF section 19): an answer lost on farm
  // signal and asked again is given back from its claim, not worked out and paid for a
  // second time. Only an answer is kept; a refusal or a failure releases the id so the retry
  // runs, and the AI holds and refusals inside the turn (A3) are untouched.
  return respondOnce(context.supabase, parsed.data.requestId ?? null, "assistant:turn", () => runAssistantTurn(context, parsed.data), {
    whileRunning: () => fail("still_working", af
      ? "Die eerste versoek word nog beantwoord. Wag 'n oomblik en probeer weer."
      : "Still answering the first request. Wait a moment, then try again.", 409),
    keep: (text) => {
      try {
        return (JSON.parse(text) as { kind?: string }).kind !== "error";
      } catch {
        return false;
      }
    },
    headers: HEADERS,
  });
}
