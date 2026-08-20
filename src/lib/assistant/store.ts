import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import type { AssistantChannel, AssistantDraft, AssistantLocale } from "./types";

export type InteractionRow = {
  id: string;
  farm_id: string;
  user_id: string;
  voice_capture_id: string | null;
  locale: AssistantLocale;
  route_tier: 0 | 1 | 2;
  input_text: string | null;
  intent: string | null;
  tool_name: string | null;
  tool_args: AssistantDraft;
  confirmation_status: string;
  result_status: string;
  proposal_expires_at: string | null;
};

type CreateInteraction = {
  farmId: string;
  userId: string;
  captureId?: string | null;
  channel: AssistantChannel;
  locale: AssistantLocale;
  tier: 0 | 1 | 2;
  input: string;
  draft: AssistantDraft;
  confirmationStatus?: "not_required" | "pending";
  resultStatus: "proposed" | "answered" | "failed";
  responseText?: string | null;
  provider?: string | null;
  model?: string | null;
  consentVersion?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  proposalExpiresAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
};

export async function supersedeVoiceCapture(input: {
  captureIds: string[];
  farmId: string;
  userId: string;
}): Promise<void> {
  const { error } = await createServiceClient().rpc("supersede_assistant_voice_capture", {
    p_capture_ids: input.captureIds,
    p_farm: input.farmId,
    p_user: input.userId,
  });
  if (error) throw error;
}

export async function ensureVoiceCapture(input: {
  requestedId?: string;
  farmId: string;
  userId: string;
  locale: AssistantLocale;
  transcript: string;
  normalizedTranscript: string;
  confidence?: number;
}): Promise<string> {
  const service = createServiceClient();
  const id = input.requestedId && /^[0-9a-f-]{36}$/i.test(input.requestedId) ? input.requestedId : randomUUID();
  const { error } = await service.from("voice_captures").insert({
    id,
    farm_id: input.farmId,
    user_id: input.userId,
    locale: input.locale,
    status: "transcribed",
    transcript: input.transcript,
    normalized_transcript: input.normalizedTranscript,
    stt_provider: "azure-speech",
    stt_confidence: input.confidence ?? null,
    transcribed_at: new Date().toISOString(),
  });
  if (!error) return id;
  if (error.code !== "23505") throw error;

  // A retry can race the original insert. A duplicate is idempotent only when every
  // immutable capture fact is identical; a reused UUID with different text is rejected.
  const { data: existing, error: lookupError } = await service
    .from("voice_captures")
    .select("id, farm_id, user_id, locale, transcript, normalized_transcript, status")
    .eq("id", id)
    .maybeSingle();
  if (lookupError || !existing) throw lookupError ?? error;
  const row = existing as {
    id: string;
    farm_id: string;
    user_id: string;
    locale: AssistantLocale;
    transcript: string | null;
    normalized_transcript: string | null;
    status: string;
  };
  if (
    row.farm_id !== input.farmId ||
    row.user_id !== input.userId ||
    row.locale !== input.locale ||
    row.transcript !== input.transcript ||
    row.normalized_transcript !== input.normalizedTranscript ||
    row.status !== "transcribed"
  ) {
    throw new Error("capture_conflict");
  }
  return row.id;
}

export async function updateVoiceCapture(
  captureId: string | null | undefined,
  userId: string,
  values: Record<string, unknown>,
): Promise<void> {
  if (!captureId) return;
  const { error } = await createServiceClient()
    .from("voice_captures")
    .update(values)
    .eq("id", captureId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function createInteraction(input: CreateInteraction): Promise<string> {
  const { data, error } = await createServiceClient()
    .from("ai_interactions")
    .insert({
      farm_id: input.farmId,
      user_id: input.userId,
      voice_capture_id: input.captureId ?? null,
      channel: input.channel,
      locale: input.locale,
      route_tier: input.tier,
      input_text: input.input,
      normalized_input: input.input.toLocaleLowerCase("en-ZA").trim(),
      intent: input.draft.intent,
      tool_name: input.draft.intent,
      tool_args: input.draft,
      confirmation_status: input.confirmationStatus ?? "not_required",
      result_status: input.resultStatus,
      response_text: input.responseText ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      confidence: input.draft.confidence,
      consent_version: input.consentVersion ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      latency_ms: input.latencyMs ?? null,
      proposal_expires_at: input.proposalExpiresAt ?? null,
      completed_at: input.completedAt ?? null,
      error_code: input.errorCode ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("interaction_insert_failed");
  return String(data.id);
}

export async function updateInteractionDraft(
  id: string,
  farmId: string,
  userId: string,
  draft: AssistantDraft,
  values: Record<string, unknown> = {},
  expectedConfirmationStatus: "not_required" | "processing" = "not_required",
): Promise<void> {
  const { data, error } = await createServiceClient()
    .from("ai_interactions")
    .update({ tool_args: draft, intent: draft.intent, tool_name: draft.intent, confidence: draft.confidence, ...values })
    .eq("id", id)
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .eq("result_status", "proposed")
    .eq("confirmation_status", expectedConfirmationStatus)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("stale_interaction");
}

/** Claim one clarification turn so two browser requests cannot rewrite one proposal. */
export async function reserveClarification(
  id: string,
  farmId: string,
  userId: string,
): Promise<InteractionRow | null> {
  const { data, error } = await createServiceClient()
    .from("ai_interactions")
    .update({ confirmation_status: "processing" })
    .eq("id", id)
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .eq("confirmation_status", "not_required")
    .eq("result_status", "proposed")
    .select(
      "id, farm_id, user_id, voice_capture_id, locale, route_tier, input_text, intent, tool_name, tool_args, confirmation_status, result_status, proposal_expires_at",
    )
    .maybeSingle();
  if (error) throw error;
  return (data as InteractionRow | null) ?? null;
}

export async function releaseClarification(id: string, farmId: string, userId: string): Promise<void> {
  const { error } = await createServiceClient()
    .from("ai_interactions")
    .update({ confirmation_status: "not_required" })
    .eq("id", id)
    .eq("farm_id", farmId)
    .eq("user_id", userId)
    .eq("confirmation_status", "processing")
    .eq("result_status", "proposed");
  if (error) throw error;
}

export async function turnRateAllowed(supabase: SupabaseClient): Promise<boolean> {
  // The database function derives the subject from auth.uid() and serializes competing
  // increments in one private bucket. Fail closed if the limiter cannot be reached.
  const { data, error } = await supabase.rpc("consume_assistant_turn");
  return !error && data === true;
}
