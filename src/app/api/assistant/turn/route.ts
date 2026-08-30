import { NextResponse } from "next/server";
import { getAssistantContext, sameOrigin } from "@/lib/assistant/context";
import { loadAssistantMachines, loadOperatorWritableMachineIds } from "@/lib/assistant/data";
import { configuredLlmModel, runAssistantAgent } from "@/lib/assistant/llm";
import {
  answerLocalRead,
  isLocalReadRequest,
  type AssistantNavigation,
  type LocalReadRequest,
} from "@/lib/assistant/local-read";
import { matchMachine, normalizeAssistantText } from "@/lib/assistant/normalize";
import { missingFields, proposalFor, queryAnswer } from "@/lib/assistant/presentation";
import { assistantTurnRequestSchema } from "@/lib/assistant/request-schema";
import type { ParsedAssistantTurnRequest } from "@/lib/assistant/request-schema";
import {
  isAssistantWriteIntent,
  machinesForAssistantDraft,
  planAssistantRoute,
  readOnlyWriteTarget,
} from "@/lib/assistant/routing";
import {
  createInteraction,
  ensureVoiceCapture,
  releaseClarification,
  reserveClarification,
  supersedeVoiceCapture,
  turnRateAllowed,
  updateInteractionDraft,
  updateVoiceCapture,
} from "@/lib/assistant/store";
import type { AssistantDraft, AssistantMachine, AssistantTurnResponse } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(body: AssistantTurnResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

function mergeClarification(
  draft: AssistantDraft,
  values: NonNullable<ParsedAssistantTurnRequest["clarification"]>,
): AssistantDraft {
  return {
    ...draft,
    machineId: values.machineId ?? draft.machineId,
    machineQuery: values.machineQuery ?? draft.machineQuery,
    description: values.description ?? draft.description,
    urgency: values.urgency ?? draft.urgency,
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

function navigationAction(
  destination: AssistantNavigation,
  locale: "en-ZA" | "af-ZA",
): { href: string; label: string } | undefined {
  const actions = {
    machines: { href: "/machines", en: "Open machines", af: "Maak masjiene oop" },
    faults: { href: "/faults", en: "Open faults", af: "Maak foute oop" },
    jobcards: { href: "/jobcards", en: "Open job cards", af: "Maak werkkaarte oop" },
    work: { href: "/work", en: "Open work requests", af: "Maak werkversoeke oop" },
    documents: { href: "/documents", en: "Open quotes and invoices", af: "Maak kwotasies en fakture oop" },
  } as const;
  if (destination === "none") return undefined;
  const action = actions[destination];
  return { href: action.href, label: locale === "af-ZA" ? action.af : action.en };
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ kind: "error", code: "forbidden", message: "Request blocked." }, 403);
  const parsedBody = assistantTurnRequestSchema.safeParse(await request.json().catch(() => null));
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

  let machines: AssistantMachine[];
  let writableMachines: AssistantMachine[];
  try {
    const machineScope = {
      role: context.role,
      userId: context.profile.id,
    };
    const [readable, operatorWritableIds] = await Promise.all([
      loadAssistantMachines(context.supabase, context.farmId, machineScope),
      context.role === "operator"
        ? loadOperatorWritableMachineIds(context.supabase, context.farmId, context.profile.id)
        : Promise.resolve<string[] | null>(null),
    ]);
    machines = readable;
    if (operatorWritableIds) {
      const writableIds = new Set(operatorWritableIds);
      writableMachines = machines.filter((machine) => writableIds.has(machine.id));
    } else {
      writableMachines = machines;
    }
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
  const readScope = {
    supabase: context.supabase,
    farmId: context.farmId,
    role: context.role,
    machines,
  };

  let captureId: string | null = null;
  let clarificationCaptureId: string | null = null;
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
      // A spoken follow-up is a separate utterance with its own capture ID. The
      // proposal remains linked to the original capture, while this row retains
      // the follow-up transcript/confidence in the same farm/user audit scope.
      if (body.channel === "voice" && body.voiceCaptureId && body.voiceCaptureId !== captureId) {
        clarificationCaptureId = await ensureVoiceCapture({
          requestedId: body.voiceCaptureId,
          farmId: context.farmId,
          userId: context.profile.id,
          locale: body.locale,
          transcript: body.input,
          normalizedTranscript: normalizeAssistantText(body.input),
          confidence: body.sttConfidence,
        });
        await updateVoiceCapture(clarificationCaptureId, context.profile.id, { status: "completed" });
      }
      if (isLocalReadRequest(previous.tool_args.localReadRequest)) {
        const selectedById = body.clarification.machineId
          ? machines.find((machine) => machine.id === body.clarification?.machineId) ?? null
          : null;
        const selectedBySpeech = !selectedById && body.clarification.machineQuery
          ? matchMachine(body.clarification.machineQuery, machines).machine
          : null;
        const selected = selectedById ?? selectedBySpeech;
        if (!selected) {
          const retry = await answerLocalRead(previous.tool_args.localReadRequest, readScope, body.locale);
          await releaseClarification(interactionId, context.farmId, context.profile.id);
          if (retry.machineOptions?.length) {
            return json({
              kind: "clarify",
              conversationId: interactionId,
              question: retry.message,
              fields: [{
                name: "machineId",
                type: "select",
                label: localized(body.locale, "Which machine?", "Watter masjien?"),
                options: retry.machineOptions.map((machine) => ({ value: machine.id, label: machine.name })),
              }],
            });
          }
          return json({
            kind: "error",
            code: "machine_not_found",
            message: localized(body.locale, "I could not identify that machine. Please start again with its full name.", "Ek kon nie daardie masjien identifiseer nie. Begin weer met sy volle naam."),
          }, 400);
        }
        const localRequest = {
          ...previous.tool_args.localReadRequest,
          machineQuery: selected.name,
        } as LocalReadRequest;
        draft = {
          ...draft,
          machineId: selected.id,
          machineQuery: selected.name,
          localReadRequest: localRequest,
        };
        const answer = await answerLocalRead(localRequest, readScope, body.locale);
        await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
          result_status: "answered",
          confirmation_status: "not_required",
          response_text: answer.message,
          completed_at: new Date().toISOString(),
        }, expectedInteractionStatus);
        await updateVoiceCapture(captureId, context.profile.id, { status: "completed", machine_id: selected.id });
        await updateVoiceCapture(clarificationCaptureId, context.profile.id, { machine_id: selected.id });
        return json({
          kind: "answer",
          conversationId: interactionId,
          message: answer.message,
          speakText: answer.speakText,
          action: navigationAction(answer.navigation, body.locale),
        });
      }
    } else {
      if (body.channel === "voice") {
        if (body.supersedesVoiceCaptureIds) {
          await supersedeVoiceCapture({
            captureIds: body.supersedesVoiceCaptureIds,
            farmId: context.farmId,
            userId: context.profile.id,
          });
        }
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

      const routePlan = planAssistantRoute(body.input, body.locale);
      draft = routePlan.draft;
      if (routePlan.kind === "local") {
        const answer = await answerLocalRead(routePlan.request, readScope, body.locale);
        if (answer.machineOptions?.length) {
          draft = { ...draft, localReadRequest: routePlan.request };
          interactionId = await createInteraction({
            farmId: context.farmId,
            userId: context.profile.id,
            captureId,
            channel: body.channel,
            locale: body.locale,
            tier: 1,
            input: body.input,
            draft,
            resultStatus: "proposed",
            responseText: answer.message,
          });
          await updateVoiceCapture(captureId, context.profile.id, { status: "parsed" });
          return json({
            kind: "clarify",
            conversationId: interactionId,
            question: answer.message,
            fields: [{
              name: "machineId",
              type: "select",
              label: localized(body.locale, "Which machine?", "Watter masjien?"),
              options: answer.machineOptions.map((machine) => ({ value: machine.id, label: machine.name })),
            }],
          });
        }
        interactionId = await createInteraction({
          farmId: context.farmId,
          userId: context.profile.id,
          captureId,
          channel: body.channel,
          locale: body.locale,
          tier: 1,
          input: body.input,
          draft,
          resultStatus: "answered",
          responseText: answer.message,
          completedAt: new Date().toISOString(),
        });
        await updateVoiceCapture(captureId, context.profile.id, {
          status: "completed",
          ...(answer.machineId ? { machine_id: answer.machineId } : {}),
        });
        return json({
          kind: "answer",
          conversationId: interactionId,
          message: answer.message,
          speakText: answer.speakText,
          action: navigationAction(answer.navigation, body.locale),
        });
      }
      if (routePlan.kind === "optional_ai") {
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
          const agent = await runAssistantAgent({
            text: body.input,
            locale: body.locale,
            model: requestedModel,
            abortSignal: request.signal,
          });
          tier = 2;
          provider = "vercel-ai-gateway";
          model = agent.model;
          inputTokens = agent.inputTokens;
          outputTokens = agent.outputTokens;
          latencyMs = agent.latencyMs;
          if (agent.kind === "answer") {
            await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
              result_status: "answered",
              confirmation_status: "not_required",
              response_text: agent.answer,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              latency_ms: latencyMs,
              completed_at: new Date().toISOString(),
            }, expectedInteractionStatus);
            await updateVoiceCapture(captureId, context.profile.id, { status: "completed" });
            return json({
              kind: "answer",
              conversationId: interactionId,
              message: agent.answer,
              speakText: agent.answer,
              action: navigationAction(agent.navigation, body.locale),
            });
          }
          draft = agent.draft;
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

    const readOnlyTarget = readOnlyWriteTarget(draft, body.input, machines, writableMachines);
    if (readOnlyTarget || (isAssistantWriteIntent(draft.intent) && writableMachines.length === 0)) {
      if (interactionId) {
        await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
          result_status: "failed",
          response_text: "The selected machine is visible but is not assigned for operator changes.",
          error_code: "machine_not_assigned",
          completed_at: new Date().toISOString(),
        }, expectedInteractionStatus).catch(() => undefined);
      }
      await updateVoiceCapture(captureId, context.profile.id, {
        status: "cancelled",
        error_code: "machine_not_assigned",
      });
      return json(
        {
          kind: "error",
          code: "machine_not_assigned",
          message: localized(
            body.locale,
            readOnlyTarget
              ? `${readOnlyTarget.name} is visible to you, but it is not assigned to you. Ask a manager to assign it before reporting a fault. Nothing was saved.`
              : "No machines are assigned to you for changes. Ask a manager to assign one before reporting a fault. Nothing was saved.",
            readOnlyTarget
              ? `${readOnlyTarget.name} is vir jou sigbaar, maar dit is nie aan jou toegewys nie. Vra 'n bestuurder om dit toe te wys voordat jy 'n fout aanmeld. Niks is gestoor nie.`
              : "Geen masjiene is aan jou toegewys vir veranderinge nie. Vra 'n bestuurder om een toe te wys voordat jy 'n fout aanmeld. Niks is gestoor nie.",
          ),
        },
        403,
      );
    }

    const intentMachines = machinesForAssistantDraft(draft, machines, writableMachines);
    const selectedMachine = draft.machineId ? intentMachines.find((machine) => machine.id === draft.machineId) ?? null : null;
    const match = selectedMachine ? { machine: selectedMachine, alternatives: [], ambiguous: false, score: 1 } : matchMachine(draft.machineQuery ?? body.input, intentMachines);
    if (match.machine) draft = { ...draft, machineId: match.machine.id, confidence: Math.min(draft.confidence, match.score) };
    else draft = { ...draft, machineId: null };

    const missing = missingFields(draft, intentMachines, body.locale, match.ambiguous ? match.alternatives : undefined);
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
      await updateVoiceCapture(clarificationCaptureId, context.profile.id, { machine_id: draft.machineId });
      return json({ kind: "clarify", conversationId: interactionId, ...missing });
    }

    const machine = intentMachines.find((candidate) => candidate.id === draft.machineId)!;
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
      await updateVoiceCapture(clarificationCaptureId, context.profile.id, { machine_id: machine.id });
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
    await updateVoiceCapture(clarificationCaptureId, context.profile.id, { machine_id: machine.id });
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
