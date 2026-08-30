import type { AssistantTurnRequest } from "./types";

export type PendingAssistantTranscript = Pick<
  AssistantTurnRequest,
  "locale" | "channel" | "voiceCaptureId" | "supersedesVoiceCaptureIds" | "sttConfidence"
>;

export const MAX_SUPERSEDED_VOICE_CAPTURES = 5;

export function pendingTranscriptFor(request: AssistantTurnRequest): PendingAssistantTranscript {
  return {
    locale: request.locale,
    channel: request.channel,
    voiceCaptureId: request.voiceCaptureId,
    supersedesVoiceCaptureIds: request.supersedesVoiceCaptureIds,
    sttConfidence: request.sttConfidence,
  };
}

export function freshVoiceRetryFor(request: AssistantTurnRequest): PendingAssistantTranscript | null {
  if (request.channel !== "voice" || !request.voiceCaptureId) return null;
  const superseded = [
    ...new Set([...(request.supersedesVoiceCaptureIds ?? []), request.voiceCaptureId]),
  ].slice(-MAX_SUPERSEDED_VOICE_CAPTURES);
  return {
    locale: request.locale,
    channel: "voice",
    voiceCaptureId: crypto.randomUUID(),
    supersedesVoiceCaptureIds: superseded,
  };
}
