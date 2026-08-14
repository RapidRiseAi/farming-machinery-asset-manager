import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import type { AssistantConfirmResponse } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requestSchema = z.object({
  proposalId: z.uuid(),
  action: z.enum(["confirm", "reject"]),
});

const rpcSuccessSchema = z.object({
  ok: z.literal(true),
  action: z.enum(["confirm", "reject"]),
  status: z.enum(["applied", "rejected"]),
  message: z.string().trim().min(1).max(8000),
  linkedRecordType: z.enum(["fault", "meter_reading", "job_card", "none"]),
  linkedRecordId: z.uuid(),
  href: z.string().trim().min(1).max(200),
  replayed: z.boolean(),
});

const rpcFailureSchema = z.object({
  ok: z.literal(false),
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(8000),
  replayed: z.boolean().optional(),
});

const rpcResultSchema = z.discriminatedUnion("ok", [rpcSuccessSchema, rpcFailureSchema]);

function json(body: AssistantConfirmResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

function localized(language: "en" | "af", english: string, afrikaans: string): string {
  return language === "af" ? afrikaans : english;
}

function failureMessage(language: "en" | "af", code: string): string {
  switch (code) {
    case "proposal_expired":
      return localized(language, "This confirmation has expired. Please start again.", "Hierdie bevestiging het verval. Begin asseblief weer.");
    case "proposal_unavailable":
    case "stale_proposal":
      return localized(language, "This proposal was already handled or is no longer pending.", "Hierdie voorstel is reeds hanteer of wag nie meer nie.");
    case "feature_unavailable":
      return localized(language, "Voice assistant access is no longer enabled for this farm.", "Stemassistenttoegang is nie meer vir hierdie plaas geaktiveer nie.");
    case "forbidden":
      return localized(language, "Your current farm role cannot apply this proposal.", "Jou huidige plaasrol kan nie hierdie voorstel toepas nie.");
    case "invalid_capture":
    case "invalid_proposal":
    case "bad_request":
      return localized(language, "This proposal is incomplete or invalid. Please start again.", "Hierdie voorstel is onvolledig of ongeldig. Begin asseblief weer.");
    default:
      return localized(language, "FleetWise could not save that change safely. Nothing was applied twice.", "FleetWise kon nie daardie verandering veilig stoor nie. Niks is twee keer toegepas nie.");
  }
}

function statusFor(code: string): number {
  if (["proposal_expired", "proposal_unavailable", "stale_proposal", "invalid_capture"].includes(code)) return 409;
  if (["forbidden", "feature_unavailable"].includes(code)) return 403;
  if (["bad_request", "invalid_proposal"].includes(code)) return 400;
  return 500;
}

function safeHref(result: z.infer<typeof rpcSuccessSchema>): string | null {
  if (result.linkedRecordType === "none") return result.href === "/assistant" ? result.href : null;
  if (result.linkedRecordType === "fault") return result.href === "/faults" ? result.href : null;
  if (result.linkedRecordType === "job_card") {
    return result.href === `/jobcards/${result.linkedRecordId}` ? result.href : null;
  }
  return /^\/machines\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.href)
    ? result.href
    : null;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json({ ok: false, code: "forbidden", message: "Request blocked." }, 403);
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ ok: false, code: "bad_request", message: "Invalid confirmation." }, 400);
  }

  const context = await getAssistantContext();
  if (!context) {
    return json({ ok: false, code: "forbidden", message: "Voice assistant access is not available." }, 403);
  }

  const language = context.profile.language;
  const { data, error } = await context.supabase.rpc("apply_assistant_proposal", {
    p_proposal_id: parsed.data.proposalId,
    p_action: parsed.data.action,
  });

  if (error) {
    const forbidden = error.code === "42501";
    const code = forbidden ? "forbidden" : "command_failed";
    return json({ ok: false, code, message: failureMessage(language, code) }, forbidden ? 403 : 500);
  }

  const result = rpcResultSchema.safeParse(data);
  if (!result.success) {
    return json({ ok: false, code: "invalid_response", message: failureMessage(language, "invalid_response") }, 502);
  }
  if (!result.data.ok) {
    return json(
      {
        ok: false,
        code: result.data.code,
        message: failureMessage(language, result.data.code),
      },
      statusFor(result.data.code),
    );
  }

  const href = safeHref(result.data);
  if (!href) {
    return json({ ok: false, code: "invalid_response", message: failureMessage(language, "invalid_response") }, 502);
  }

  if (result.data.linkedRecordType === "fault") {
    revalidatePath("/faults");
  } else if (result.data.linkedRecordType === "meter_reading") {
    revalidatePath(href);
    revalidatePath("/machines");
  } else if (result.data.linkedRecordType === "job_card") {
    revalidatePath(href);
    revalidatePath("/jobcards");
    revalidatePath("/machines");
  }

  return json({
    ok: true,
    message: result.data.message,
    linkedRecordType: result.data.linkedRecordType,
    linkedRecordId: result.data.linkedRecordId,
    href,
  });
}
