import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { confirmAssistantProposal } from "@/lib/assistant/confirm-proposal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const schema = z.object({ proposalId: z.uuid(), action: z.enum(["confirm", "reject"]) });

export async function POST(request: Request) {
  const fail = (code: string, message: string, status: number) => NextResponse.json(
    { ok: false, code, message }, { status, headers: { "Cache-Control": "private, no-store" } },
  );
  if (!sameOrigin(request)) return fail("forbidden", "Request blocked.", 403);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("bad_request", "Invalid confirmation.", 400);
  const context = await getAssistantContext();
  if (!context) return fail("forbidden", "Voice assistant access is not available.", 403);
  return confirmAssistantProposal(context, parsed.data);
}
