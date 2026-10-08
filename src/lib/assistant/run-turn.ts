import "server-only";
import { after, NextResponse } from "next/server";
import type { AssistantContext } from "@/lib/assistant/context";
import { loadAssistantMachines, loadOperatorWritableMachineIds } from "@/lib/assistant/data";
import {
  AssistantAgentInvalidOutput,
  configuredLlmFallbackModel,
  configuredLlmModel,
  LLM_MAX_OUTPUT_TOKENS,
  runAssistantAgent,
} from "@/lib/assistant/llm";
import { aiHelpOn } from "@/lib/assistant/transcription";
import { loadFarmOpenAiKey, markFarmKeyFailed, type FarmKey } from "@/lib/ai-usage/farm-key";
import { gatewayOptions } from "@/lib/ai-usage/gateway-options";
import { reportModelRefused } from "@/lib/ai-usage/health";
import { answerHoldUnits } from "@/lib/ai-usage/hold-units";
import { holdBudget, settleHold, type Attempt, type HoldRefusal } from "@/lib/ai-usage/ledger";
import { farmOpenAi, openAiModelId, OWN_KEY_RESPONSE_OPTIONS } from "@/lib/ai-usage/openai-direct";
import { createServiceClient } from "@/lib/supabase/service";
import { classifyAiFailure } from "@/lib/ai-usage/outcome";
import { aiErrorForLog } from "@/lib/ai-usage/safe-log";
import {
  answerLocalRead, scopeForChosenMachine,
  isLocalReadRequest,
  type AssistantNavigation,
  type LocalReadRequest,
} from "@/lib/assistant/local-read";
import { matchMachine, normalizeAssistantText } from "@/lib/assistant/normalize";
import { missingFields, proposalFor, queryAnswer } from "@/lib/assistant/presentation";
import type { ParsedAssistantTurnRequest } from "@/lib/assistant/request-schema";
import {
  isAssistantWriteIntent,
  matchAcrossHypotheses,
  matchAssistantMachine,
  machinesForAssistantDraft,
  planAcrossHypotheses,
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
import type { AssistantDraft, AssistantLocale, AssistantMachine, AssistantTurnResponse } from "@/lib/assistant/types";


function json(body: AssistantTurnResponse, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

/** The system prompt and date line, counted into the input-token hold for an AI answer. */
const AGENT_PROMPT_CHARS = 2_600;

/**
 * The model an answer on a farm's own key runs on. The key is an OpenAI key, so only an
 * OpenAI model can use it: anything else configured falls back to gpt-5-mini rather than
 * running on the platform's account while the ledger says the farm paid.
 */
function ownKeyLlmModel(): string {
  const configured = process.env.ASSISTANT_BYOK_LLM_MODEL?.trim();
  return configured && openAiModelId(configured) ? configured : "openai/gpt-5-mini";
}

function aiUnavailable(locale: AssistantLocale): AssistantTurnResponse {
  return {
    kind: "error",
    code: "ai_unavailable",
    message: locale === "af-ZA"
      ? "AI-hulp is tydelik nie beskikbaar nie. Tik ’n eenvoudiger opdrag of gebruik die gewone vorm."
      : "AI help is temporarily unavailable. Type a simpler command or use the normal form.",
  };
}

/**
 * AI did not run because of a limit or a switch: a plain answer, not a failure, so the
 * turn still ends calmly and the free paths (typing, the normal forms) stay in reach.
 */
function aiPaused(reason: Exclude<HoldRefusal, "not_member" | "unavailable" | "voice_off" | "token_rate">, locale: AssistantLocale): AssistantTurnResponse {
  const af = locale === "af-ZA";
  const message = {
    farm_limit: af
      ? "AI en stem is gepouseer: jou plaas het sy maandelikse limiet bereik. Tik en die gewone vorms werk steeds."
      : "AI and voice are paused: your farm has reached its monthly limit. Typing and the normal forms still work.",
    member_limit: af
      ? "Jy het jou AI-limiet vir hierdie maand bereik. Tik en die gewone vorms werk steeds."
      : "You have reached your AI limit for this month. Typing and the normal forms still work.",
    ai_off: af
      ? "AI-hulp is vir hierdie plaas afgeskakel. Tik en die gewone vorms werk steeds."
      : "AI help is switched off for this farm. Typing and the normal forms still work.",
    ai_off_for_you: af
      ? "AI-hulp is vir jou afgeskakel. Jy kan dit in die assistent weer aanskakel."
      : "AI help is switched off for you. You can switch it back on in the assistant.",
    // The current app shows the notice instead of this; an older installed copy has no
    // notice to show, so it is told how to get one.
    notice_required: af
      ? "Lees eers die kennisgewing oor AI-hulp: laai die toep weer as jy dit nie sien nie."
      : "Read the note about AI help first: reload the app if you do not see it.",
    own_key_broken: af
      ? "AI-hulp is gepouseer: die plaas se eie OpenAI-sleutel werk nie. Tik en die gewone vorms werk steeds."
      : "AI help is paused: the farm's own OpenAI key is not working. Typing and the normal forms still work.",
  }[reason];
  return { kind: "error", code: "ai_paused", reason, message };
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

export async function runAssistantTurn(context: AssistantContext, body: ParsedAssistantTurnRequest) {
  const channel = context.sourceChannel ?? body.channel;
  const hearings = body.clarification ? [] : (body.alternatives ?? []);
  const hearingTexts = hearings.map((hearing) => hearing.text);
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
        // The person chose this machine by id. Read about THAT machine, see
        // scopeForChosenMachine for why re-matching its name can ask again.
        const answer = await answerLocalRead(
          localRequest,
          scopeForChosenMachine(readScope, selected.id) ?? readScope,
          body.locale,
        );
        // Never record a "which machine?" reply as an answer. It produced a dead
        // end, the same question returned as the final answer, with no picker -
        // and wrote that question into the person's history as answered.
        if (answer.machineOptions?.length) {
          await releaseClarification(interactionId, context.farmId, context.profile.id);
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

      const { plan: routePlan } = planAcrossHypotheses(body.input, body.locale, hearings);
      draft = routePlan.draft;
      if (routePlan.kind === "local") {
        // The shown transcript can garble a name that another hearing got right ("Ruby
        // Bakkies" / "rooi bakkie"): answer about the machine the hearings agree on.
        let localScope = readScope;
        const spokenName = "machineQuery" in routePlan.request ? routePlan.request.machineQuery : undefined;
        if (hearings.length && spokenName && !matchMachine(spokenName, machines).machine) {
          const agreed = matchAcrossHypotheses([spokenName, ...hearingTexts], machines);
          if (agreed.machine) localScope = scopeForChosenMachine(readScope, agreed.machine.id) ?? readScope;
        }
        const answer = await answerLocalRead(routePlan.request, localScope, body.locale);
        if (answer.machineOptions?.length) {
          draft = { ...draft, localReadRequest: routePlan.request };
          interactionId = await createInteraction({
            farmId: context.farmId,
            userId: context.profile.id,
            captureId,
            channel,
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
          channel,
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
        // The owner's farm-wide switch first: on a farm with AI switched off there is
        // nothing for this person to agree to, so no consent card is offered (and no notice
        // recorded) for it. The hold below checks the switch again.
        const { data: farmAi, error: farmAiError } = await createServiceClient()
          .from("farm_ai_settings")
          .select("ai_enabled")
          .eq("farm_id", context.farmId)
          .maybeSingle();
        if (farmAiError) return json(aiUnavailable(body.locale), 503);
        if (farmAi?.ai_enabled === false) return json(aiPaused("ai_off", body.locale));
        // AI help on: the notice seen (nothing leaves the country before), switched on, not
        // withdrawn. The hold below applies it again with the farm's switch and limits.
        // Switched on but never shown the notice: an installed copy of an older build, whose
        // consent card would loop (allow, resubmit, the same card). Only the notice itself,
        // in the current app, unlocks AI for this person, so say that plainly.
        if (context.profile.ai_processing_opt_in && !context.profile.ai_processing_withdrawn_at
            && !context.profile.ai_notice_seen_at) {
          return json(aiPaused("notice_required", body.locale));
        }
        if (!aiHelpOn(context.profile)) {
          interactionId = await createInteraction({
            farmId: context.farmId,
            userId: context.profile.id,
            captureId,
            channel,
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
        // Who pays, with which model: a farm's own OpenAI key runs an OpenAI model at OpenAI
        // directly, on that key (never through the Gateway, which falls back to ours when a
        // key fails); otherwise the platform's model on ours. Resolved before the permit
        // row (which records the model) and the hold (which prices it).
        const farmKey: FarmKey = await loadFarmOpenAiKey(context.farmId);
        if (farmKey.state === "unavailable") return json(aiUnavailable(body.locale), 503);
        if (farmKey.state === "broken" && farmKey.fallback === "pause") {
          return json(aiPaused("own_key_broken", body.locale));
        }
        const ownKey = farmKey.state === "active" ? farmKey.key : null;
        let requestedModel: string;
        try {
          requestedModel = ownKey ? ownKeyLlmModel() : configuredLlmModel();
        } catch {
          return json(aiUnavailable(body.locale), 503);
        }
        const ownKeyModelId = ownKey ? openAiModelId(requestedModel) : null;
        const holdUnits = answerHoldUnits(AGENT_PROMPT_CHARS + body.input.length, LLM_MAX_OUTPUT_TOKENS);
        const hold = await holdBudget({
          farmId: context.farmId,
          userId: context.profile.id,
          feature: "ai_answer",
          model: requestedModel,
          units: holdUnits,
          credential: ownKey ? "farm_openai" : "platform",
        });
        if (!hold.ok) {
          if (hold.reason === "unavailable" || hold.reason === "not_member" || hold.reason === "voice_off" || hold.reason === "token_rate") {
            return json(aiUnavailable(body.locale), 503);
          }
          return json(aiPaused(hold.reason, body.locale));
        }
        // Settled exactly once, after the response is sent, so a dropped connection still
        // writes the row and no later failure can overwrite a paid call with a free one.
        let settled = false;
        const settleOnce = (attempts: Attempt[]) => {
          if (settled) return;
          settled = true;
          after(async () => {
            await settleHold(hold.id, attempts);
          });
        };
        try {
          // This committed row is the consent permit and audit evidence. Its database
          // trigger re-checks live, unwithdrawn consent before any transcript text is
          // sent to the cross-border model provider.
          interactionId = await createInteraction({
            farmId: context.farmId,
            userId: context.profile.id,
            captureId,
            channel,
            locale: body.locale,
            tier: 2,
            input: body.input,
            draft,
            resultStatus: "proposed",
            provider: ownKey ? "openai" : "vercel-ai-gateway",
            model: requestedModel,
            consentVersion: context.profile.ai_processing_consent_version,
          });
        } catch (error) {
          // No call was made: release the hold at zero.
          settleOnce([{ model: requestedModel, outcome: "cancelled", errorCode: "permit_refused" }]);
          if (errorCode(error) === "42501") {
            const consentInteractionId = await createInteraction({
              farmId: context.farmId,
              userId: context.profile.id,
              captureId,
              channel,
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

        // One call to a model, on the server's own deadline (LLM_AGENT_TIMEOUT_MS), never the
        // browser's connection: once budget is held the call finishes and is settled, so
        // closing the page cannot make a paid answer free.
        const callModel = (attemptModel: string) =>
          runAssistantAgent({
            text: body.input,
            locale: body.locale,
            model: attemptModel,
            ...(ownKey && ownKeyModelId
              ? {
                  languageModel: farmOpenAi(ownKey)(ownKeyModelId),
                  providerOptions: OWN_KEY_RESPONSE_OPTIONS,
                }
              : {
                  providerOptions: {
                    gateway: gatewayOptions({
                      farmId: context.farmId,
                      userId: null,
                      feature: "ai_answer",
                      zeroDataRetention: process.env.ASSISTANT_TRANSCRIBE_ZDR === "1",
                    }),
                  },
                }),
          }).then(
            (agent) => ({ ok: true as const, agent }),
            (error: unknown) => ({ ok: false as const, error }),
          );

        // A failed attempt: logged, settled on its own hold, a farm key marked if it was
        // refused. Returns whether the Gateway refused the MODEL itself on our account (no
        // access on this plan, unknown model), which the fallback below can answer.
        const settleFailedAttempt = (error: unknown, attemptModel: string, settle: (attempts: Attempt[]) => void) => {
          // Only the model call is classified here; storage after it is not an AI failure.
          const failure = classifyAiFailure(error, Boolean(ownKey));
          // Name, type and status only: the error object can carry a farm's own key.
          console.warn(JSON.stringify({
            event: "assistant_llm_failed",
            model: attemptModel,
            ...aiErrorForLog(error),
            outcome: error instanceof AssistantAgentInvalidOutput ? "invalid_output" : failure.outcome,
          }));
          if (error instanceof AssistantAgentInvalidOutput) {
            // The model answered and was paid for, but with nothing usable: its real cost is
            // recorded, the farm is not billed, and it is not the provider failing.
            const used = error.usage;
            const measuredUnits = used.inputTokens !== null || used.outputTokens !== null;
            settle([{
              model: used.model,
              outcome: "failed",
              errorCode: "invalid_output",
              charged: true,
              ...(measuredUnits
                ? { units: { input_tokens: used.inputTokens ?? undefined, output_tokens: used.outputTokens ?? undefined }, measured: "server" as const }
                : { units: holdUnits, measured: "estimated" as const }),
              costUsd: used.costUsd,
              generationId: used.generationId,
              latencyMs: used.latencyMs,
            }]);
            return false;
          }
          settle([{
            model: attemptModel,
            outcome: failure.outcome,
            errorCode: failure.code,
            // Cut off at the deadline after it was sent: the provider probably charged, so
            // the held units are recorded as its estimated cost (the farm is not billed).
            ...(failure.outcome === "timeout" ? { units: holdUnits, measured: "estimated" as const } : {}),
          }]);
          if (ownKey && failure.outcome === "key_invalid") {
            after(() => markFarmKeyFailed(context.farmId, failure.code === "farm_key_quota" ? "farm_key_quota" : "farm_key_refused"));
          }
          const modelRefused = !ownKey && (failure.code === "gateway_auth" || failure.code === "model_not_found");
          // Every call to a refused model fails until a person acts: tell the founder now.
          if (modelRefused) after(() => reportModelRefused(attemptModel, error));
          return modelRefused;
        };

        let attemptModel = requestedModel;
        let settleAttempt = settleOnce;
        let attempt = await callModel(attemptModel);
        if (!attempt.ok && settleFailedAttempt(attempt.error, attemptModel, settleAttempt)) {
          // The Gateway refused the configured model outright on our account (for example
          // "Free tier users do not have access to this model"): answer with the fallback
          // model instead of failing every hard request until someone changes LLM_MODEL.
          // Its own hold; the refused call is already settled at nothing.
          const fallbackModel = configuredLlmFallbackModel(requestedModel);
          if (fallbackModel) {
            const fallbackHold = await holdBudget({
              farmId: context.farmId,
              userId: context.profile.id,
              feature: "ai_answer",
              model: fallbackModel,
              units: holdUnits,
              credential: "platform",
            });
            if (fallbackHold.ok) {
              let fallbackSettled = false;
              settleAttempt = (attempts: Attempt[]) => {
                if (fallbackSettled) return;
                fallbackSettled = true;
                after(async () => {
                  await settleHold(fallbackHold.id, attempts);
                });
              };
              attemptModel = fallbackModel;
              attempt = await callModel(attemptModel);
              if (!attempt.ok) settleFailedAttempt(attempt.error, attemptModel, settleAttempt);
            }
          }
        }
        if (!attempt.ok) {
          await updateInteractionDraft(interactionId, context.farmId, context.profile.id, draft, {
            result_status: "failed",
            response_text: "The optional AI provider did not return a usable interpretation.",
            error_code: "llm_unavailable",
            completed_at: new Date().toISOString(),
          }, expectedInteractionStatus).catch(() => undefined);
          await updateVoiceCapture(captureId, context.profile.id, { status: "failed", error_code: "llm_unavailable" });
          return json(aiUnavailable(body.locale), 503);
        }
        const agent = attempt.agent;
        settleAttempt([{
          model: agent.model,
          outcome: "ok",
          units: { input_tokens: agent.inputTokens ?? undefined, output_tokens: agent.outputTokens ?? undefined },
          costUsd: agent.costUsd,
          generationId: agent.generationId,
          measured: agent.costUsd !== null ? "gateway" : "server",
          latencyMs: agent.latencyMs,
        }]);
        // From here a failure is storage, handled by the route's own catch; the paid call
        // is already settled as answered.
        tier = 2;
        provider = ownKey ? "openai" : "vercel-ai-gateway";
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

    const readOnlyTarget = readOnlyWriteTarget(draft, body.input, machines, writableMachines, hearingTexts);
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
    const match = matchAssistantMachine(draft, body.input, machines, writableMachines, hearingTexts);
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
          channel,
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
          channel,
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
        channel,
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
