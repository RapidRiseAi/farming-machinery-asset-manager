import { NextResponse } from "next/server";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { assistantTurnRequestSchema } from "@/lib/assistant/request-schema";
import { runAssistantTurn } from "@/lib/assistant/run-turn";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    { kind: "error", code, message }, { status, headers: { "Cache-Control": "private, no-store" } },
  );
  if (!sameOrigin(request)) return fail("forbidden", "Request blocked.", 403);
  const parsed = assistantTurnRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("bad_request", "Check the command and try again.", 400);
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", parsed.data.locale === "af-ZA"
    ? "Stemassistenttoegang is nie vir hierdie plaas en rol beskikbaar nie."
    : "Voice assistant access is not available for this farm and role.", 403);
  return runAssistantTurn(context, parsed.data);
}
