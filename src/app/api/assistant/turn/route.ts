import { NextResponse } from "next/server";
import { z } from "zod";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { loadAssistantMachines } from "@/lib/assistant/data";
import { configuredLlmModel, parseWithLlm } from "@/lib/assistant/llm";
import { matchMachine, normalizeAssistantText } from "@/lib/assistant/normalize";
import { parseDeterministic } from "@/lib/assistant/parser";
import { missingFields, proposalFor, queryAnswer } from "@/lib/assistant/presentation";
import {
  createInteraction,
  ensureVoiceCapture,
  releaseClarification,
  reserveClarification,
  turnRateAllowed,
  updateInteractionDraft,
  updateVoiceCapture,
} from "@/lib/assistant/store";
import type { AssistantDraft, AssistantTurnResponse } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const requestSchema = z.object({
  input: z.string().trim().min(1).max(2000),
  locale: z.enum(["en-ZA", "af-ZA"]),
  channel: z.enum(["typed", "voice"]),
  voiceCaptureId: z.uuid().optional(),
  sttConfidence: z.number().min(0).max(1).optional(),
  clarification: z
    .object({
      interactionId: z.uuid(),
      machineId: z.uuid().optional(),
      description: z.string().trim().min(1).max(2000).optional(),
      workPerformed: z.string().trim().max(2000).optional(),
      reading: z.number().min(0).optional(),
      readingDate: z.iso.date().optional(),
      serviceDate: z.iso.date().optional(),
    })
    .optional(),
});

function json(body: AssistantTurnResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

function mergeClarification(draft: AssistantDraft, values: NonNullable<z.infer<typeof requestSchema>["clarification"]>): AssistantDraft {
  return {
    ...draft,
    machineId: values.machineId ?? draft.machineId,
    description: values.description ?? draft.description,
    workPerformed: values.workPerformed ?? draft.workPerformed,
    reading: values.reading ?? draft.reading,
    readingDate: values.readingDate ?? draft.readingDate,
    serviceDate: values.serviceDate ?? draft.serviceDate,
  };
}

function roleAllowsIntent(role: string, intent: AssistantDraft["intent"]): boolean {
  if (intent === "query_asset_status" || intent === "query_service_due") return true;
  if (intent === "report_fault") return ["rr_admin", "owner", "manager", "mechanic", "operator"].includes(role);
  if (intent === "log_reading" || intent === "log_service") {
    return ["rr_admin", "owner", "manager", "mechanic"].includes(role);
  }
  return false;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function localized(locale: "en-ZA" | "af-ZA", english: string, afrikaans: string): string {
  return locale === "af-ZA" ? afrikaans : english;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ kind: "error", code: "forbidden", message: "Request blocked." }, 403);
  const parsedBody = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) return json({ kind: "error", code: "bad_request", message: "Check the command and try again." }, 400);
  const body = parsedBody.data;

  const context = await getAssistantContext();
  if (!context) {
    return json(
      {
        kind: "error",
        code: "forbidden",
        message: localized(
          body.locale,
          "Voice assistant access is not available for this farm and role.",
          "Stemassistenttoegang is nie vir hierdie plaas en rol beskikbaar nie.",
        ),
      },
      403,
    );
  }
  if (!(await turnRateAllowed(context.supabase))) {
    return json({
      kind: "error",
      code: "rate_limited",
      message: localized(body.locale, "Please wait a moment before trying again.", "Wag asseblief ’n oomblik en probeer weer."),
    }, 429);
  }

  let machines;
  try {
    machines = await loadAssistantMachines(context.supabase, context.farmId, {
      role: context.role,
      userId: context.profile.id,
    });
  } catch {
    return json({
      kind: "error",
      code: "data_unavailable",
      message: localized(body.locale, "Fleet data is temporarily unavailable.", "Vlootdata is tydelik nie beskikbaar nie."),
    }, 503);
  }
  if (machines.length === 0) {
    const isOperator = context.role === "operator";
    return json({
      kind: "error",
      code: "no_machines",
      message: isOperator
        ? localized(
            body.locale,
            "No machines are assigned to you on this farm. Ask a manager to assign one first.",
            "Geen masjiene is op hierdie plaas aan jou toegewys nie. Vra eers ’n bestuurder om een toe te wys.",
          )
        : localized(
            body.locale,
            "Add a machine before using the assistant.",
            "Voeg ’n masjien by voordat jy die assistent gebruik.",
          ),
      fallbackHref: isOperator ? "/machines" : "/machines/new",
    }, 400);
  }

  let captureId: string | null = null;
  let interactionId: string | null = null;
  let tier: 0 | 1 | 2 = 1;
  let draft: AssistantDraft;
  let provider: string | null = null;
  let model: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let latencyMs: number | null = null;
  let expectedInteractionStatus: "not_required" | "processing" = "not_required";

  try {
    if (body.clarification) {
      const previous = await reserveClarification(
        body.clarification.interactionId,
        context.farmId,
        context.profile.id,
      );
      if (!previous) {
        return json({
          kind: "error",
          code: "stale_turn",
          message: localized(body.locale, "That question has expired. Please start again.", "Daardie vraag het verval. Begin asseblief weer."),
        }, 409);
      }
      interactionId = previous.id;
      expectedInteractionStatus = "processing";
      captureId = previous.voice_capture_id;
      tier = previous.route_tier;
      draft = mergeClarification(previous.tool_args, body.clarification);
    } else {
      if (body.channel === "voice") {
        captureId = await ensureVoiceCapture({
          requestedId: body.voiceCaptureId,
          farmId: context.farmId,
          userId: context.profile.id,
          locale: body.locale,
          transcript: body.input,
          normalizedTranscript: normalizeAssistantText(body.input),
          confidence: body.sttConfidence,
        });
      }

      draft = parseDeterministic(body.input, body.locale);
      if (!draft.intent) {
        if (!context.profile.ai_processing_opt_in || !context.profile.ai_processing_consent_version) {
          interactionId = await createInteraction({
            farmId: context.farmId,
            userId: context.profile.id,
            captureId,
            channel: body.channel,
            locale: body.locale,
            tier: 1,
            input: body.input,
            draft,
            resultStatus: "failed",
            responseText: "Optional AI help requires consent.",
            errorCode: "consent_required",
            completedAt: new Date().toISOString(),
          });
          await updateVoiceCapture(captureId, context.profile.id, { status: "parsed" });
          return json({
            kind: "needs_consent",
            conversationId: interactionId,
            explanation:
              body.locale === "af-ZA"
                ? "Ek kon dit nie met die plaaslike reëls uitwerk nie. Met jou toestemming kan die teks deur ons AI-verskaffer buite Suid-Afrika verwerk word."
                : "The local rules could not resolve this command. With your permission, the text can be processed by our AI provider outside South Africa.",
          });
        }
        let requestedModel: string;
        try {
          requestedModel = configuredLlmModel();
          // This committed row is the consent permit and audit evidence. Its database
          // trigger re-checks live, unwithdrawn consent before any transcript text is
          // sent to the cross-border model provider.
          interactionId = await createInteraction({
            farmId: context.farmId,
            userId: context.profile.id,
            captureId,
            channel: body.channel,
            locale: body.locale,
            tier: 2,
            input: body.input,
            draft,
            resultStatus: "proposed",
            provider: "vercel-ai-gateway",
            model: requestedModel,
            consentVersion: context.profile.ai_processing_consent_version,
          });
        } catch (error) {
          if (errorCode(error) === "42501") {
            const consentInteractionId = await createInteraction({
              farmId: context.farmId,
              userId: context.profile.id,
              captureId,
              channel: body.channel,
              locale: body.locale,
              tier: 1,
              input: body.input,
              draft,
              resultStatus: "failed",
              responseText: "Optional AI help requires active consent.",
              errorCode: "consent_required",
              completedAt: new Date().toISOString(),
            }).catch(() => null);
            if (consentInteractionId) {
              return json({
                kind: "needs_consent",
                conversationId: consentInteractionId,
                explanation:
                  body.locale === "af-ZA"
                    ? "Jou AI-toestemming is nie meer aktief nie. Gee weer toestemming as jy wil hê die moeilike teks moet deur ons AI-verskaffer verwerk word."
                    : "Your AI consent is no longer active. Allow it again if you want difficult text processed by our AI provider.",
              });
            }
          }
          return json(
            {
              kind: "error",
              code: "ai_unavailable",
              message:
                body.locale === "af-ZA"
                  ? "AI-hulp is tydelik nie beskikbaar nie. Tik ’n eenvoudiger opdrag of gebruik die gewone vorm."
                  : "AI help is temporarily unavailable. Type a simpler command or use the normal form.",
            },
            503,
          );
        }

        try {
          const llm = await parseWithLlm(body.input, body.locale, requestedModel);
          draft = llm.draft;
          tier = 2;
          provider = "vercel-ai-gateway";
          model = llm.model;
          inputTokens = llm.inputTokens;
          outputTokens = llm.outputTokens;
          latencyMs = llm.latencyMs;
          await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
          }, expectedInteractionStatus);
        } catch {
          await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
            result_status: "failed",
            response_text: "The optional AI provider did not return a usable interpretation.",
            error_code: "llm_unavailable",
            completed_at: new Date().toISOString(),
          }, expectedInteractionStatus).catch(() => undefined);
          await updateVoiceCapture(captureId, context.profile.id, { status: "failed", error_code: "llm_unavailable" });
          return json(
            {
              kind: "error",
              code: "ai_unavailable",
              message: body.locale === "af-ZA" ? "AI-hulp is tydelik nie beskikbaar nie. Tik ’n eenvoudiger opdrag of gebruik die gewone vorm." : "AI help is temporarily unavailable. Type a simpler command or use the normal form.",
            },
            503,
          );
        }
      }
    }

    if (!draft.intent) {
      if (interactionId) {
        await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
          result_status: "failed",
          response_text: "The assistant could not determine an allowed intent.",
          error_code: "unknown_intent",
          completed_at: new Date().toISOString(),
        }, expectedInteractionStatus).catch(() => undefined);
      }
      return json({ kind: "error", code: "unknown_intent", message: body.locale === "af-ZA" ? "Ek verstaan nog nie wat jy wil doen nie." : "I still do not understand what you want to do." }, 400);
    }

    if (!roleAllowsIntent(context.role, draft.intent)) {
      if (interactionId) {
        await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
          result_status: "failed",
          response_text: "The selected-farm role cannot perform this intent.",
          error_code: "role_forbidden",
          completed_at: new Date().toISOString(),
        }, expectedInteractionStatus).catch(() => undefined);
      }
      await updateVoiceCapture(captureId, context.profile.id, { status: "cancelled", error_code: "role_forbidden" });
      return json(
        {
          kind: "error",
          code: "role_forbidden",
          message:
            body.locale === "af-ZA"
              ? "Jou rol mag nie daardie verandering maak nie. Geen data is gestoor nie."
              : "Your role cannot make that change. Nothing was saved.",
        },
        403,
      );
    }

    const selectedMachine = draft.machineId ? machines.find((machine) => machine.id === draft.machineId) ?? null : null;
    const match = selectedMachine ? { machine: selectedMachine, alternatives: [], ambiguous: false, score: 1 } : matchMachine(draft.machineQuery ?? body.input, machines);
    if (match.machine) draft = { ...draft, machineId: match.machine.id, confidence: Math.min(draft.confidence, match.score) };
    else draft = { ...draft, machineId: null };

    const missing = missingFields(draft, machines, body.locale, match.ambiguous ? match.alternatives : undefined);
    if (missing) {
      if (interactionId) {
        await updateInteractionDraft(
          interactionId,
          context.farmId,
          context.profile.id,
          draft,
          expectedInteractionStatus === "processing" ? { confirmation_status: "not_required" } : {},
          expectedInteractionStatus,
        );
      } else {
        interactionId = await createInteraction({
          farmId: context.farmId,
          userId: context.profile.id,
          captureId,
          channel: body.channel,
          locale: body.locale,
          tier,
          input: body.input,
          draft,
          resultStatus: "proposed",
          provider,
          model,
          consentVersion: model ? context.profile.ai_processing_consent_version : null,
          inputTokens,
          outputTokens,
          latencyMs,
        });
      }
      await updateVoiceCapture(captureId, context.profile.id, { status: "parsed", machine_id: draft.machineId });
      return json({ kind: "clarify", conversationId: interactionId, ...missing });
    }

    const machine = machines.find((candidate) => candidate.id === draft.machineId)!;
    if (draft.intent === "query_asset_status" || draft.intent === "query_service_due") {
      const answer = queryAnswer(draft, machine, body.locale);
      if (interactionId) {
        await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
          result_status: "answered",
          confirmation_status: "not_required",
          response_text: answer,
          completed_at: new Date().toISOString(),
        }, expectedInteractionStatus);
      } else {
        interactionId = await createInteraction({
          farmId: context.farmId,
          userId: context.profile.id,
          captureId,
          channel: body.channel,
          locale: body.locale,
          tier,
          input: body.input,
          draft,
          resultStatus: "answered",
          responseText: answer,
          provider,
          model,
          consentVersion: model ? context.profile.ai_processing_consent_version : null,
          inputTokens,
          outputTokens,
          latencyMs,
          completedAt: new Date().toISOString(),
        });
      }
      await updateVoiceCapture(captureId, context.profile.id, { status: "completed", machine_id: machine.id });
      return json({ kind: "answer", conversationId: interactionId, message: answer, speakText: answer });
    }

    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    if (interactionId) {
      await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
        confirmation_status: "pending",
        proposal_expires_at: expiresAt,
      }, expectedInteractionStatus);
    } else {
      interactionId = await createInteraction({
        farmId: context.farmId,
        userId: context.profile.id,
        captureId,
        channel: body.channel,
        locale: body.locale,
        tier,
        input: body.input,
        draft,
        confirmationStatus: "pending",
        resultStatus: "proposed",
        provider,
        model,
        consentVersion: model ? context.profile.ai_processing_consent_version : null,
        inputTokens,
        outputTokens,
        latencyMs,
        proposalExpiresAt: expiresAt,
      });
    }
    await updateVoiceCapture(captureId, context.profile.id, {
      status: "awaiting_confirmation",
      machine_id: machine.id,
    });
    return json({
      kind: "confirm",
      conversationId: interactionId,
      proposal: proposalFor(interactionId, draft, machine, body.locale, expiresAt),
    });
  } catch {
    if (interactionId && expectedInteractionStatus === "processing") {
      await releaseClarification(interactionId, context.farmId, context.profile.id).catch(() => undefined);
    }
    await updateVoiceCapture(captureId, context.profile.id, { status: "failed", error_code: "turn_failed" }).catch(() => undefined);
    return json({
      kind: "error",
      code: "turn_failed",
      message: localized(
        body.locale,
        "The assistant could not process that request safely.",
        "Die assistent kon nie daardie versoek veilig verwerk nie.",
      ),
    }, 500);
  }
}
