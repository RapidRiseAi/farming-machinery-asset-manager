"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSpeechClient,
  SpeechClientError,
  type SpeechClient,
  type SpeechClientErrorCode,
} from "./speech-client";
import {
  clearOfflineCaptures,
  deleteOfflineCapture,
  enableOfflineVoiceStorage,
  listOfflineCaptures,
  MAX_OFFLINE_RECORDING_MS,
  OfflineVoiceRecorder,
  offlineCaptureToWav,
  saveOfflineCapture,
  type OfflineVoiceCapture,
} from "./offline-voice";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { MicIcon, StopIcon, SendIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/components/ui/cn";
import { StatusBadge, type StatusBadgeProps } from "@/components/ui/badge";
import { dateTime } from "@/lib/format";
import type { ThreadEntry, ThreadStatus } from "@/lib/assistant/thread";
import { t, type Lang } from "@/lib/i18n";
import type {
  AssistantClarification,
  AssistantConfirmResponse,
  AssistantMachine,
  AssistantTurnRequest,
  AssistantTurnResponse,
  AssistantLocale,
} from "@/lib/assistant/types";
import {
  freshVoiceRetryFor,
  pendingTranscriptFor,
  type PendingAssistantTranscript,
} from "@/lib/assistant/voice-retry";
import { recognitionLocales, speechVocabulary, voiceForLocale } from "@/lib/assistant/speech-plan";
import { clarificationFromSpeech } from "@/lib/assistant/spoken-clarification";

type Phase =
  | "idle"
  | "requesting_permission"
  | "listening"
  | "stopping"
  | "interpreting"
  | "committing"
  | "speaking"
  | "error";

type Capabilities = {
  reportFault: boolean;
  logReading: boolean;
  logService: boolean;
  queryStatus: boolean;
  queryServiceDue: boolean;
};

type Completion = { message: string; href?: string };
type ClarifyTurn = Extract<AssistantTurnResponse, { kind: "clarify" }>;
const ASSISTANT_TURN_TIMEOUT_MS = 30_000;

function responseError(value: unknown, locale: Lang): AssistantTurnResponse {
  if (value && typeof value === "object" && "kind" in value) return value as AssistantTurnResponse;
  return { kind: "error", code: "invalid_response", message: t("assistant.invalidResponse", locale) };
}

function speechErrorMessage(error: unknown, locale: Lang): string {
  const code: SpeechClientErrorCode = error instanceof SpeechClientError ? error.code : "unknown";
  return t(`assistant.speechError.${code}`, locale);
}

/**
 * Status chips for the thread, from the shared shape vocabulary. An answered
 * question carries none: the answer is the whole story, and a chip on every
 * reply would turn the one meaningful signal into wallpaper.
 */
const THREAD_STATUS_LOOK: Record<ThreadStatus, Pick<StatusBadgeProps, "tone" | "shape"> | null> = {
  answered: null,
  applied: { tone: "ok", shape: "check" },
  rejected: { tone: "neutral", shape: "dash" },
  pending: { tone: "warning", shape: "clock" },
  expired: { tone: "neutral", shape: "ring" },
  unfinished: { tone: "neutral", shape: "ring" },
  superseded: { tone: "neutral", shape: "dash" },
  failed: { tone: "danger", shape: "square" },
};

/** Static `t()` calls rather than a key map, so `pnpm i18n:keys` can see every one. */
function threadStatusLabel(status: ThreadStatus, locale: Lang): string {
  switch (status) {
    case "applied":
      return t("assistant.threadApplied", locale);
    case "rejected":
      return t("assistant.threadRejected", locale);
    case "pending":
      return t("assistant.threadPending", locale);
    case "expired":
      return t("assistant.threadExpired", locale);
    case "unfinished":
      return t("assistant.threadUnfinished", locale);
    case "superseded":
      return t("assistant.threadSuperseded", locale);
    case "failed":
      return t("assistant.threadFailed", locale);
    default:
      return "";
  }
}

function phaseLabel(phase: Phase, locale: Lang): string {
  switch (phase) {
    case "requesting_permission":
      return t("assistant.requestingMic", locale);
    case "listening":
      return t("assistant.listening", locale);
    case "stopping":
      return t("assistant.transcribing", locale);
    case "interpreting":
      return t("assistant.interpreting", locale);
    case "committing":
      return t("assistant.saving", locale);
    case "speaking":
      return t("assistant.speaking", locale);
    case "error":
      return t("assistant.needsAttention", locale);
    default:
      return t("assistant.ready", locale);
  }
}

export function AssistantClient({
  locale,
  offlineContextKey,
  initialSpeechLanguage,
  machines,
  initialAiConsent,
  capabilities,
  initialThread,
}: {
  locale: Lang;
  offlineContextKey: string;
  initialSpeechLanguage: AssistantLocale;
  machines: AssistantMachine[];
  initialAiConsent: boolean;
  capabilities: Capabilities;
  /** Past exchanges on this farm, oldest first, read through RLS by the page. */
  initialThread: ThreadEntry[];
}) {
  const [speechLanguage, setSpeechLanguage] = useState<AssistantLocale>(initialSpeechLanguage);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [typedInput, setTypedInput] = useState("");
  const [turn, setTurn] = useState<AssistantTurnResponse | null>(null);
  const [pendingTranscript, setPendingTranscript] = useState<PendingAssistantTranscript | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [aiConsent, setAiConsent] = useState(initialAiConsent);
  const [consentUpdating, setConsentUpdating] = useState(false);
  const [online, setOnline] = useState(true);
  const [offlineCaptures, setOfflineCaptures] = useState<OfflineVoiceCapture[]>([]);
  const [offlineProcessing, setOfflineProcessing] = useState(false);
  const speechRef = useRef<SpeechClient | null>(null);
  const offlineRecorderRef = useRef<OfflineVoiceRecorder | null>(null);
  const recordingOfflineRef = useRef(false);
  const offlineOperationRef = useRef(false);
  const offlineRecordingTimerRef = useRef<number | null>(null);
  const liveRecordingTimerRef = useRef<number | null>(null);
  const stopListeningRef = useRef<() => Promise<void>>(async () => undefined);
  const recordingRequestedRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const commitInFlightRef = useRef(false);
  const speechInFlightRef = useRef(false);
  const contextRef = useRef(offlineContextKey);
  const transcriptRef = useRef("");
  const finalSegmentsRef = useRef<string[]>([]);
  const finalIdsRef = useRef(new Set<string>());
  const confidenceTotalRef = useRef(0);
  const confidenceWeightRef = useRef(0);
  const captureIdRef = useRef<string | null>(null);
  const lastRequestRef = useRef<AssistantTurnRequest | null>(null);
  const spokenClarificationRef = useRef<{
    turn: ClarifyTurn;
    field: ClarifyTurn["fields"][number];
    request: AssistantTurnRequest;
  } | null>(null);
  const resultRegionRef = useRef<HTMLHeadingElement | null>(null);
  const operationRef = useRef(0);
  const mountedRef = useRef(true);

  // ── The thread ─────────────────────────────────────────────────────────
  // Past exchanges. The LIVE exchange is not in here: it keeps rendering as the
  // cards below until the live area clears, and only then moves up into the
  // thread (see the transition effect). An exchange is therefore always in
  // exactly one place, which is what stops it rendering twice.
  const [thread, setThread] = useState<ThreadEntry[]>(initialThread);
  const initialThreadRef = useRef(initialThread);
  initialThreadRef.current = initialThread;
  /** What was asked, captured when a new request is sent, for the entry it becomes. */
  const liveInputRef = useRef<{ input: string; channel: "typed" | "voice"; createdAt: string } | null>(null);
  /** The live exchange as it would read in history, refreshed on every change. */
  const liveSnapshotRef = useRef<ThreadEntry | null>(null);
  /** Set only by a successful confirmation, so its completion can be recorded. */
  const lastProposalIdRef = useRef<string | null>(null);
  const confirmedActionRef = useRef<"confirm" | "reject" | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  // Expiry is judged against the clock only after mount. Until then the server's
  // own verdict stands, so the server and first client render agree and a
  // proposal crossing its deadline mid-hydration cannot cause a mismatch.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const machineVocabulary = useMemo(() => speechVocabulary(machines), [machines]);

  const getSpeech = useCallback(() => {
    if (!speechRef.current) speechRef.current = createSpeechClient();
    return speechRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      if (offlineRecordingTimerRef.current !== null) {
        window.clearTimeout(offlineRecordingTimerRef.current);
        offlineRecordingTimerRef.current = null;
      }
      if (liveRecordingTimerRef.current !== null) {
        window.clearTimeout(liveRecordingTimerRef.current);
        liveRecordingTimerRef.current = null;
      }
      const client = speechRef.current;
      speechRef.current = null;
      offlineRecorderRef.current?.cancel();
      offlineRecorderRef.current = null;
      recordingOfflineRef.current = false;
      recordingRequestedRef.current = false;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      commitInFlightRef.current = false;
      speechInFlightRef.current = false;
      if (client) void client.dispose();
    };
  }, []);

  const refreshOfflineCaptures = useCallback(async () => {
    const context = offlineContextKey;
    try {
      const captures = await listOfflineCaptures(context);
      if (mountedRef.current && contextRef.current === context) setOfflineCaptures(captures);
    } catch {
      // IndexedDB may be blocked in a private browser; online voice remains available.
    }
  }, [offlineContextKey]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    const context = offlineContextKey;
    enableOfflineVoiceStorage();
    contextRef.current = context;
    operationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    if (offlineRecordingTimerRef.current !== null) {
      window.clearTimeout(offlineRecordingTimerRef.current);
      offlineRecordingTimerRef.current = null;
    }
    if (liveRecordingTimerRef.current !== null) {
      window.clearTimeout(liveRecordingTimerRef.current);
      liveRecordingTimerRef.current = null;
    }
    offlineRecorderRef.current?.cancel();
    offlineRecorderRef.current = null;
    recordingOfflineRef.current = false;
    recordingRequestedRef.current = false;
    const speech = speechRef.current;
    speechRef.current = null;
    if (speech) void speech.dispose();
    offlineOperationRef.current = false;
    setOfflineProcessing(false);
    setConsentUpdating(false);
    commitInFlightRef.current = false;
    speechInFlightRef.current = false;
    setAiConsent(initialAiConsent);
    setSpeechLanguage(initialSpeechLanguage);
    setTurn(null);
    setPendingTranscript(null);
    setCompletion(null);
    setError(null);
    setTranscript("");
    transcriptRef.current = "";
    setTypedInput("");
    setFieldValues({});
    lastRequestRef.current = null;
    spokenClarificationRef.current = null;
    // A different person or farm: the previous farm's exchange must not be
    // archived into this farm's thread on the next transition.
    liveInputRef.current = null;
    liveSnapshotRef.current = null;
    lastProposalIdRef.current = null;
    confirmedActionRef.current = null;
    setThread(initialThreadRef.current);
    setPhase("idle");
    update();
    setOfflineCaptures([]);
    void listOfflineCaptures(context).then(
      (captures) => {
        if (mountedRef.current && contextRef.current === context) setOfflineCaptures(captures);
      },
      () => undefined,
    );
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [initialAiConsent, initialSpeechLanguage, offlineContextKey]);

  useEffect(() => {
    if (turn || completion || error) {
      const timer = window.setTimeout(() => resultRegionRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [turn, completion, error]);

  useEffect(() => {
    if (turn?.kind !== "clarify") return;
    const initial: Record<string, string> = {};
    for (const field of turn.fields) {
      if (field.type !== "select" && field.value != null) initial[field.name] = String(field.value);
    }
    setFieldValues(initial);
  }, [turn]);

  /**
   * Moves the live exchange into the thread when — and only when — the live area
   * clears. One effect rather than an archive call at every place that resets
   * state: there are a dozen of those (new request, cancel, language switch,
   * offline processing, farm change) and the next one somebody adds would forget.
   *
   * While an error, a consent prompt or an offline notice is showing, the
   * snapshot is kept: the exchange is not over, and a retry that succeeds will
   * refresh the same entry by id rather than add a second one.
   */
  useEffect(() => {
    const live = liveInputRef.current;
    let snapshot: ThreadEntry | null = null;
    if (live) {
      const base = {
        input: live.input,
        channel: live.channel,
        createdAt: live.createdAt,
        response: null,
        href: null,
        proposal: null,
      } satisfies Omit<ThreadEntry, "id" | "status">;
      if (turn?.kind === "answer") {
        snapshot = { ...base, id: turn.conversationId, status: "answered", response: turn.message };
      } else if (turn?.kind === "confirm") {
        snapshot = { ...base, id: turn.conversationId, status: "pending", proposal: turn.proposal };
      } else if (turn?.kind === "clarify") {
        snapshot = { ...base, id: turn.conversationId, status: "unfinished" };
      } else if (!turn && completion && lastProposalIdRef.current) {
        snapshot = {
          ...base,
          id: lastProposalIdRef.current,
          status: confirmedActionRef.current === "reject" ? "rejected" : "applied",
          response: completion.message,
          href: completion.href ?? null,
        };
      }
    }
    if (snapshot) {
      liveSnapshotRef.current = snapshot;
      return;
    }
    if (turn || completion) return;
    const previous = liveSnapshotRef.current;
    if (!previous) return;
    liveSnapshotRef.current = null;
    lastProposalIdRef.current = null;
    confirmedActionRef.current = null;
    setThread((current) => [...current.filter((entry) => entry.id !== previous.id), previous]);
  }, [turn, completion]);

  /**
   * Re-opens a pending proposal from history as the live confirmation card, with
   * the facts the server rebuilt. The existing confirm card and `confirmProposal`
   * do the rest, so reviewing from history adds no second way to save a change.
   */
  const reviewEntry = (entry: ThreadEntry) => {
    if (!entry.proposal || (phase !== "idle" && phase !== "error")) return;
    const previous = liveSnapshotRef.current;
    if (previous && previous.id !== entry.id) {
      // Setting a new turn directly skips the cleared state the transition
      // effect archives on, so file the outgoing exchange here.
      setThread((current) => [...current.filter((item) => item.id !== previous.id), previous]);
    }
    liveSnapshotRef.current = null;
    operationRef.current += 1;
    liveInputRef.current = {
      input: entry.input ?? "",
      channel: entry.channel === "voice" ? "voice" : "typed",
      createdAt: entry.createdAt,
    };
    lastProposalIdRef.current = null;
    confirmedActionRef.current = null;
    lastRequestRef.current = null;
    spokenClarificationRef.current = null;
    setError(null);
    setCompletion(null);
    setPendingTranscript(null);
    setTurn({ kind: "confirm", conversationId: entry.id, proposal: entry.proposal });
  };

  const submitRequest = useCallback(
    async (requestBody: AssistantTurnRequest) => {
      if (requestAbortRef.current) return false;
      const retryTranscript = requestBody.clarification ? null : pendingTranscriptFor(requestBody);
      if (!navigator.onLine) {
        if (retryTranscript) setPendingTranscript(retryTranscript);
        setPhase("error");
        setError(t("assistant.offlineTyped", locale));
        return false;
      }
      const controller = new AbortController();
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ASSISTANT_TURN_TIMEOUT_MS);
      requestAbortRef.current = controller;
      const operation = ++operationRef.current;
      // A clarification continues the same exchange and keeps its original
      // question; anything else starts a new one.
      if (!requestBody.clarification || !liveInputRef.current) {
        liveInputRef.current = {
          input: requestBody.input,
          channel: requestBody.channel,
          createdAt: new Date().toISOString(),
        };
        lastProposalIdRef.current = null;
        confirmedActionRef.current = null;
      }
      lastRequestRef.current = requestBody;
      setPhase("interpreting");
      setError(null);
      setCompletion(null);
      try {
        const response = await fetch("/api/assistant/turn", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        const next = responseError(await response.json().catch(() => null), locale);
        if (!mountedRef.current || operation !== operationRef.current) return false;
        setTurn(next);
        if (!response.ok || next.kind === "error") {
          if (retryTranscript) setPendingTranscript(freshVoiceRetryFor(requestBody) ?? retryTranscript);
          setError(next.kind === "error" ? next.message : t("assistant.serviceUnavailable", locale));
          setPhase("error");
          return false;
        }
        setPhase("idle");
        return true;
      } catch {
        if (!mountedRef.current || operation !== operationRef.current) return false;
        if (retryTranscript) setPendingTranscript(freshVoiceRetryFor(requestBody) ?? retryTranscript);
        setError(t(timedOut ? "assistant.requestTimedOut" : "assistant.serviceUnavailable", locale));
        setPhase("error");
        return false;
      } finally {
        window.clearTimeout(timeout);
        if (requestAbortRef.current === controller) requestAbortRef.current = null;
      }
    },
    [locale],
  );

  const processOfflineCapture = useCallback(
    async (capture: OfflineVoiceCapture) => {
      if (!navigator.onLine || offlineOperationRef.current || (phase !== "idle" && phase !== "error")) return;
      if (capture.contextKey !== offlineContextKey) return;
      const operation = ++operationRef.current;
      offlineOperationRef.current = true;
      setOfflineProcessing(true);
      setPhase("stopping");
      setError(null);
      setCompletion(null);
      setTurn(null);
      setPendingTranscript(null);
      setTranscript("");
      transcriptRef.current = "";
      lastRequestRef.current = null;
      try {
        const wav = await offlineCaptureToWav(capture);
        let confidenceTotal = 0;
        let confidenceWeight = 0;
        const text = await getSpeech().recognizeFile(wav, {
          locale: capture.locale,
          autoDetectLocales: recognitionLocales(capture.locale),
          phrases: machineVocabulary,
          onFinal: (result) => {
            if (result.confidence == null) return;
            const weight = Math.max(1, result.durationMs);
            confidenceTotal += result.confidence * weight;
            confidenceWeight += weight;
          },
        });
        if (!mountedRef.current || operation !== operationRef.current) return;
        transcriptRef.current = text;
        setTranscript(text);
        setPendingTranscript({
          locale: capture.locale,
          channel: "voice",
          voiceCaptureId: capture.id,
          sttConfidence: confidenceWeight > 0 ? confidenceTotal / confidenceWeight : undefined,
        });
        await deleteOfflineCapture(capture.id, offlineContextKey);
        await refreshOfflineCaptures();
        if (mountedRef.current && operation === operationRef.current) setPhase("idle");
      } catch (caught) {
        if (!mountedRef.current || operation !== operationRef.current) return;
        const message = caught instanceof SpeechClientError
          ? speechErrorMessage(caught, locale)
          : t("assistant.offlineProcessFailed", locale);
        setError(message);
        setPhase("error");
      } finally {
        if (operation === operationRef.current && contextRef.current === offlineContextKey) {
          offlineOperationRef.current = false;
          if (mountedRef.current) setOfflineProcessing(false);
        }
      }
    },
    [getSpeech, locale, machineVocabulary, offlineContextKey, phase, refreshOfflineCaptures],
  );

  const removeOfflineCaptures = async (capture?: OfflineVoiceCapture) => {
    if (offlineOperationRef.current || (phase !== "idle" && phase !== "error")) return;
    if (capture && capture.contextKey !== offlineContextKey) return;
    const operation = ++operationRef.current;
    const context = offlineContextKey;
    offlineOperationRef.current = true;
    setOfflineProcessing(true);
    setPhase("stopping");
    setError(null);
    try {
      if (capture) await deleteOfflineCapture(capture.id, context);
      else await clearOfflineCaptures(context);
      await refreshOfflineCaptures();
      if (!mountedRef.current || operation !== operationRef.current || contextRef.current !== context) return;
      if (!capture) {
        setTurn(null);
        setPendingTranscript(null);
        lastRequestRef.current = null;
        setCompletion({ message: t("assistant.offlineCleared", locale) });
      }
      if (mountedRef.current) setPhase("idle");
    } catch {
      if (mountedRef.current && operation === operationRef.current && contextRef.current === context) {
        setError(t("assistant.offlineDiscardFailed", locale));
        setPhase("error");
      }
    } finally {
      if (operation === operationRef.current && contextRef.current === context) {
        offlineOperationRef.current = false;
        if (mountedRef.current) setOfflineProcessing(false);
      }
    }
  };

  const finishOfflineRecording = async () => {
    if (!recordingOfflineRef.current) return false;
    recordingOfflineRef.current = false;
    recordingRequestedRef.current = false;
    if (offlineRecordingTimerRef.current !== null) {
      window.clearTimeout(offlineRecordingTimerRef.current);
      offlineRecordingTimerRef.current = null;
    }
    const recorder = offlineRecorderRef.current;
    offlineRecorderRef.current = null;
    const context = offlineContextKey;
    const operation = operationRef.current;
    const captureId = captureIdRef.current;
    if (!recorder || !captureId) {
      setError(t("assistant.recognitionFailed", locale));
      setPhase("error");
      return true;
    }
    try {
      const capture = await recorder.stop({
        id: captureId,
        contextKey: context,
        locale: speechLanguage,
      });
      if (!mountedRef.current || operation !== operationRef.current || contextRef.current !== context) {
        return true;
      }
      await saveOfflineCapture(capture);
      if (!mountedRef.current || operation !== operationRef.current || contextRef.current !== context) {
        await deleteOfflineCapture(capture.id, context).catch(() => undefined);
        return true;
      }
      await refreshOfflineCaptures();
      setCompletion({ message: t("assistant.offlineCaptured", locale) });
      setPhase("idle");
    } catch {
      if (!mountedRef.current || operation !== operationRef.current || contextRef.current !== context) {
        return true;
      }
      setError(t("assistant.offlineRecordingUnavailable", locale));
      setPhase("error");
    }
    return true;
  };

  const startListening = async () => {
    if (recordingRequestedRef.current || (phase !== "idle" && phase !== "error")) return;
    recordingRequestedRef.current = true;
    const operation = ++operationRef.current;
    const spokenFollowUp = navigator.onLine && turn?.kind === "clarify" && turn.fields.length === 1 && lastRequestRef.current
      ? { turn, field: turn.fields[0], request: lastRequestRef.current }
      : null;
    spokenClarificationRef.current = spokenFollowUp;
    setError(null);
    if (!spokenFollowUp) setTurn(null);
    setCompletion(null);
    setPendingTranscript(null);
    setTranscript("");
    transcriptRef.current = "";
    finalSegmentsRef.current = [];
    finalIdsRef.current = new Set();
    confidenceTotalRef.current = 0;
    confidenceWeightRef.current = 0;
    captureIdRef.current = crypto.randomUUID();
    setPhase("requesting_permission");

    if (!navigator.onLine) {
      try {
        const recorder = await OfflineVoiceRecorder.start(() => {
          void finishOfflineRecording();
        });
        if (!mountedRef.current || operation !== operationRef.current) {
          recordingRequestedRef.current = false;
          recorder.cancel();
          return;
        }
        offlineRecorderRef.current = recorder;
        recordingOfflineRef.current = true;
        setPhase("listening");
        offlineRecordingTimerRef.current = window.setTimeout(() => {
          void finishOfflineRecording();
        }, MAX_OFFLINE_RECORDING_MS);
      } catch {
        if (!mountedRef.current || operation !== operationRef.current) return;
        recordingRequestedRef.current = false;
        setError(t("assistant.offlineRecordingUnavailable", locale));
        setPhase("error");
      }
      return;
    }

    try {
      await getSpeech().startRecognition({
        locale: speechLanguage,
        autoDetectLocales: recognitionLocales(speechLanguage),
        phrases: machineVocabulary,
        onPartial: (result) => {
          if (!mountedRef.current || operation !== operationRef.current) return;
          const prefix = finalSegmentsRef.current.join(" ");
          const value = `${prefix}${prefix ? " " : ""}${result.text}`.trim();
          transcriptRef.current = value;
          setTranscript(value);
        },
        onFinal: (result) => {
          if (!mountedRef.current || operation !== operationRef.current) return;
          if (finalIdsRef.current.has(result.resultId)) return;
          finalIdsRef.current.add(result.resultId);
          finalSegmentsRef.current.push(result.text);
          if (result.confidence != null) {
            const weight = Math.max(1, result.durationMs);
            confidenceTotalRef.current += result.confidence * weight;
            confidenceWeightRef.current += weight;
          }
          const value = finalSegmentsRef.current.join(" ").trim();
          transcriptRef.current = value;
          setTranscript(value);
        },
        onNoMatch: () => {
          if (mountedRef.current && operation === operationRef.current) {
            setError(t("assistant.noSpeech", locale));
          }
        },
        onError: (speechError) => {
          if (!mountedRef.current || operation !== operationRef.current) return;
          if (liveRecordingTimerRef.current !== null) {
            window.clearTimeout(liveRecordingTimerRef.current);
            liveRecordingTimerRef.current = null;
          }
          setError(speechErrorMessage(speechError, locale));
          recordingRequestedRef.current = false;
          setPhase("error");
        },
        onStateChange: (state) => {
          if (state === "listening" && mountedRef.current && operation === operationRef.current) {
            setPhase("listening");
          }
        },
      });
      if (mountedRef.current && operation === operationRef.current) {
        liveRecordingTimerRef.current = window.setTimeout(() => {
          void stopListeningRef.current();
        }, MAX_OFFLINE_RECORDING_MS);
      }
    } catch (caught) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      recordingRequestedRef.current = false;
      if (liveRecordingTimerRef.current !== null) {
        window.clearTimeout(liveRecordingTimerRef.current);
        liveRecordingTimerRef.current = null;
      }
      const message = caught instanceof SpeechClientError
        ? speechErrorMessage(caught, locale)
        : t("assistant.recognitionFailed", locale);
      setError(message);
      setPhase("error");
    }
  };

  const stopListening = async () => {
    if (phase !== "listening" && phase !== "requesting_permission") return;
    if (phase === "requesting_permission" && !offlineRecorderRef.current && !speechRef.current) {
      operationRef.current += 1;
      recordingRequestedRef.current = false;
      setPhase("idle");
      return;
    }
    recordingRequestedRef.current = false;
    if (liveRecordingTimerRef.current !== null) {
      window.clearTimeout(liveRecordingTimerRef.current);
      liveRecordingTimerRef.current = null;
    }
    setPhase("stopping");
    if (await finishOfflineRecording()) return;
    try {
      await getSpeech().stopRecognition();
      const input = transcriptRef.current.trim();
      if (!input) {
        setError(t("assistant.noSpeech", locale));
        setPhase("error");
        return;
      }
      setPendingTranscript({
        locale: speechLanguage,
        channel: "voice",
        voiceCaptureId: captureIdRef.current ?? crypto.randomUUID(),
        sttConfidence: confidenceWeightRef.current > 0
          ? confidenceTotalRef.current / confidenceWeightRef.current
          : undefined,
      });
      lastRequestRef.current = null;
      setPhase("idle");
    } catch {
      setError(t("assistant.recognitionFailed", locale));
      setPhase("error");
    }
  };
  stopListeningRef.current = stopListening;

  const submitTyped = async () => {
    const input = typedInput.trim();
    if (!input || (phase !== "idle" && phase !== "error")) return;
    operationRef.current += 1;
    setTurn(null);
    setCompletion(null);
    setError(null);
    setPendingTranscript(null);
    setTranscript(input);
    transcriptRef.current = input;
    spokenClarificationRef.current = null;
    await submitRequest({ input, locale: speechLanguage, channel: "typed" });
  };

  const interpretTranscript = async () => {
    const input = transcriptRef.current.trim();
    if (!pendingTranscript || !input || (phase !== "idle" && phase !== "error")) return;
    const spokenFollowUp = spokenClarificationRef.current;
    if (spokenFollowUp) {
      const clarification = clarificationFromSpeech(
        spokenFollowUp.turn.conversationId,
        spokenFollowUp.field,
        input,
      );
      if (!clarification) {
        setTurn(spokenFollowUp.turn);
        setError(t("assistant.fillRequired", locale));
        return;
      }
      const continuation: AssistantTurnRequest = {
        ...spokenFollowUp.request,
        ...pendingTranscript,
        input,
        clarification,
      };
      delete continuation.supersedesVoiceCaptureIds;
      spokenClarificationRef.current = null;
      setPendingTranscript(null);
      await submitRequest(continuation);
      return;
    }
    setPendingTranscript(null);
    await submitRequest({ ...pendingTranscript, input });
  };

  const updateTranscript = (value: string) => {
    operationRef.current += 1;
    const previous = lastRequestRef.current;
    const freshVoiceRetry = previous ? freshVoiceRetryFor(previous) : null;
    transcriptRef.current = value;
    setTranscript(value);
    setPendingTranscript((current) => {
      const pending = current ?? {
        locale: previous?.locale ?? speechLanguage,
        channel: previous?.channel ?? "typed",
        voiceCaptureId: previous?.voiceCaptureId,
      };
      return freshVoiceRetry ?? pending;
    });
    lastRequestRef.current = null;
    setTurn(null);
    setCompletion(null);
    setError(null);
    setPhase("idle");
  };

  const submitClarification = async () => {
    if (turn?.kind !== "clarify" || (phase !== "idle" && phase !== "error")) return;
    const previous = lastRequestRef.current;
    if (!previous) return;
    const clarification: AssistantClarification = { interactionId: turn.conversationId };
    for (const field of turn.fields) {
      const raw = fieldValues[field.name]?.trim();
      if (!raw) {
        setError(t("assistant.fillRequired", locale));
        return;
      }
      if (field.name === "reading") clarification.reading = Number(raw);
      else if (field.name === "machineId") clarification.machineId = raw;
      else if (field.name === "description") clarification.description = raw;
      else if (field.name === "urgency") clarification.urgency = raw as AssistantClarification["urgency"];
      else if (field.name === "workPerformed") clarification.workPerformed = raw;
      else if (field.name === "readingDate") clarification.readingDate = raw;
      else if (field.name === "serviceDate") clarification.serviceDate = raw;
    }
    const continuation = { ...previous, clarification };
    delete continuation.supersedesVoiceCaptureIds;
    await submitRequest(continuation);
  };

  const confirmProposal = async (action: "confirm" | "reject") => {
    if (commitInFlightRef.current || turn?.kind !== "confirm" || (phase !== "idle" && phase !== "error")) return;
    commitInFlightRef.current = true;
    const operation = ++operationRef.current;
    setPhase("committing");
    setError(null);
    try {
      const response = await fetch("/api/assistant/confirm", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ proposalId: turn.proposal.proposalId, action }),
      });
      const result = (await response.json().catch(() => null)) as AssistantConfirmResponse | null;
      if (!mountedRef.current || operation !== operationRef.current) return;
      if (!result || !response.ok || !result.ok) {
        setError(result && !result.ok ? result.message : t("assistant.saveFailed", locale));
        setPhase("error");
        return;
      }
      lastProposalIdRef.current = turn.proposal.proposalId;
      confirmedActionRef.current = action;
      setTurn(null);
      setCompletion({ message: result.message, href: result.href === "/assistant" ? undefined : result.href });
      setPhase("idle");
    } catch {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setError(t("assistant.saveFailed", locale));
      setPhase("error");
    } finally {
      commitInFlightRef.current = false;
    }
  };

  const updateAiConsent = async (allow: boolean) => {
    if (commitInFlightRef.current || (phase !== "idle" && phase !== "error")) return;
    commitInFlightRef.current = true;
    const operation = ++operationRef.current;
    setConsentUpdating(true);
    setPhase("committing");
    setError(null);
    try {
      const response = await fetch("/api/assistant/consent", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ allow }),
      });
      if (!response.ok) throw new Error("consent_failed");
      if (!mountedRef.current || operation !== operationRef.current) return;
      setAiConsent(allow);
      if (!allow) {
        lastRequestRef.current = null;
        setTurn(null);
        setCompletion({ message: t("assistant.consentWithdrawn", locale) });
        setConsentUpdating(false);
        setPhase("idle");
        return;
      }
      const previous = lastRequestRef.current;
      setConsentUpdating(false);
      if (previous) {
        // The first no-consent attempt already moved a voice capture out of the
        // insertable state. Re-submit voice text as a fresh, explicitly linked
        // capture; typed requests can be retried unchanged.
        const voiceRetry = freshVoiceRetryFor(previous);
        await submitRequest({ ...previous, ...(voiceRetry ?? {}), clarification: undefined });
      }
      else setPhase("idle");
    } catch {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setConsentUpdating(false);
      setError(t(allow ? "assistant.consentFailed" : "assistant.consentWithdrawFailed", locale));
      setPhase("error");
    } finally {
      commitInFlightRef.current = false;
    }
  };

  const readAloud = async (text: string) => {
    if (speechInFlightRef.current || (phase !== "idle" && phase !== "error")) return;
    speechInFlightRef.current = true;
    const operation = ++operationRef.current;
    setError(null);
    setPhase("speaking");
    try {
      const responseLocale = lastRequestRef.current?.locale ?? speechLanguage;
      await getSpeech().speak(text, { voice: voiceForLocale(responseLocale) });
      if (mountedRef.current && operation === operationRef.current) setPhase("idle");
    } catch (caught) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      if (caught instanceof SpeechClientError && caught.code === "cancelled") {
        setPhase("idle");
        return;
      }
      setError(caught instanceof SpeechClientError ? speechErrorMessage(caught, locale) : t("assistant.speechFailed", locale));
      setPhase("error");
    } finally {
      speechInFlightRef.current = false;
    }
  };

  const reset = async () => {
    operationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setPhase("stopping");
    if (offlineRecordingTimerRef.current !== null) {
      window.clearTimeout(offlineRecordingTimerRef.current);
      offlineRecordingTimerRef.current = null;
    }
    if (liveRecordingTimerRef.current !== null) {
      window.clearTimeout(liveRecordingTimerRef.current);
      liveRecordingTimerRef.current = null;
    }
    offlineRecorderRef.current?.cancel();
    offlineRecorderRef.current = null;
    recordingOfflineRef.current = false;
    recordingRequestedRef.current = false;
    await getSpeech().stopRecognition().catch(() => undefined);
    await getSpeech().stopSpeaking().catch(() => undefined);
    setTurn(null);
    setPendingTranscript(null);
    setCompletion(null);
    setError(null);
    setTranscript("");
    setTypedInput("");
    transcriptRef.current = "";
    lastRequestRef.current = null;
    spokenClarificationRef.current = null;
    setPhase("idle");
  };

  const examples = [
    capabilities.reportFault
      ? speechLanguage === "af-ZA"
        ? "Meld die hidrouliese lek op die John Deere aan."
        : "Report a hydraulic leak on the John Deere."
      : null,
    capabilities.logReading
      ? speechLanguage === "af-ZA"
        ? "Teken 4323 enjinure vir die Massey Ferguson aan."
        : "Log 4323 engine hours for the Massey Ferguson."
      : null,
    capabilities.logService
      ? speechLanguage === "af-ZA"
        ? "Die 250-uur diens op die John Deere is klaar by 4500 ure."
        : "The John Deere 250-hour service is complete at 4500 hours."
      : null,
    capabilities.queryServiceDue
      ? speechLanguage === "af-ZA"
        ? "Wanneer is die John Deere se volgende diens?"
        : "When is the John Deere due for service?"
      : null,
  ].filter((value): value is string => Boolean(value));

  const isListening = phase === "listening" || phase === "requesting_permission";
  const isBusy = ["stopping", "interpreting", "committing", "speaking"].includes(phase);
  // The live exchange's id, hidden from the thread while it is live so the same
  // exchange never shows twice — for instance a pending proposal being reviewed.
  const liveId =
    turn && "conversationId" in turn
      ? turn.conversationId
      : completion && lastProposalIdRef.current
        ? lastProposalIdRef.current
        : null;
  const visibleThread = liveId ? thread.filter((entry) => entry.id !== liveId) : thread;

  // Keep the newest exchange in view, inside the thread's own scroll region —
  // never by moving the page, which would yank somebody away from what they
  // were reading.
  useEffect(() => {
    const el = threadScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleThread.length]);
  const answerText = turn?.kind === "answer" ? turn.message : completion?.message;
  const answerSpeechText = turn?.kind === "answer" ? (turn.speakText ?? turn.message) : completion?.message;
  const confirmationSpeechText = turn?.kind === "confirm"
    ? [turn.proposal.title, ...turn.proposal.facts.map((fact) => `${fact.label}: ${fact.value}`)].join(". ")
    : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("assistant.title", locale)}</h1>
        <p className="mt-1 text-sm leading-6 text-sand-600">{t("assistant.lead", locale)}</p>
      </header>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-sand-200 bg-sand-50 p-1" aria-label={t("assistant.languageLabel", locale)}>
        {(["af-ZA", "en-ZA"] as const).map((language) => (
          <button
            key={language}
            type="button"
            disabled={isListening || isBusy}
            aria-pressed={speechLanguage === language}
            onClick={() => {
              operationRef.current += 1;
              setSpeechLanguage(language);
              setTurn(null);
              setCompletion(null);
              setError(null);
              setPendingTranscript(null);
              setTranscript("");
              transcriptRef.current = "";
              lastRequestRef.current = null;
              spokenClarificationRef.current = null;
            }}
            className={cn(
              "focus-ring min-h-[48px] rounded-lg px-3 text-sm font-semibold transition-colors",
              speechLanguage === language ? "bg-surface text-brand-ink shadow-xs" : "text-sand-600 hover:bg-white/70",
            )}
          >
            {language === "af-ZA" ? t("assistant.languageAf", locale) : t("assistant.languageEn", locale)}
          </button>
        ))}
      </div>
      <p className="-mt-3 text-xs leading-5 text-sand-500">{t("assistant.languageHint", locale)}</p>

      {offlineCaptures.length > 0 ? (
        <Card className="border-callout-warn-edge bg-callout-warn-bg/50">
          <CardTitle>{t("assistant.offlineTitle", locale)}</CardTitle>
          <p className="mt-1 text-sm text-sand-700">
            {t("assistant.offlinePending", locale).replace("{count}", String(offlineCaptures.length))}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={!online || isBusy || offlineProcessing}
              loading={offlineProcessing}
              onClick={() => void processOfflineCapture(offlineCaptures[0])}
            >
              {online ? t("assistant.offlineProcess", locale) : t("assistant.waitingForSignal", locale)}
            </Button>
            <Button
              variant="ghost"
              disabled={isBusy || offlineProcessing}
              onClick={() => void removeOfflineCaptures(offlineCaptures[0])}
            >
              {t("assistant.offlineDiscard", locale)}
            </Button>
            <Button
              variant="ghost"
              disabled={isBusy || offlineProcessing}
              onClick={() => void removeOfflineCaptures()}
            >
              {t("assistant.offlineClearAll", locale)}
            </Button>
          </div>
        </Card>
      ) : null}

      {visibleThread.length > 0 ? (
        <section aria-labelledby="assistant-thread-title" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="assistant-thread-title" className="text-sm font-semibold text-ink">
              {t("assistant.threadTitle", locale)}
            </h2>
            {/* True, and worth saying: ai_interactions_sel returns only the
                subject's own rows — not a colleague's, not the farm owner's. */}
            <p className="text-xs text-ink-subtle">{t("assistant.threadPrivate", locale)}</p>
          </div>
          <div
            ref={threadScrollRef}
            tabIndex={0}
            aria-label={t("assistant.threadTitle", locale)}
            className="focus-ring max-h-[28rem] overflow-y-auto rounded-xl border border-edge-soft bg-surface-sunken/40 p-3 sm:p-4"
          >
            <ol className="flex flex-col gap-5">
              {visibleThread.map((entry) => {
                // A pending proposal that crossed its deadline since load is
                // shown as expired and loses its Review button.
                const shown: ThreadStatus =
                  entry.status === "pending" &&
                  (!entry.proposal || (nowMs !== null && Date.parse(entry.proposal.expiresAt) <= nowMs))
                    ? "expired"
                    : entry.status;
                const look = THREAD_STATUS_LOOK[shown];
                const reviewable = shown === "pending" && entry.proposal !== null;
                return (
                  <li key={entry.id} className="flex flex-col gap-1.5">
                    {/* The time heads the exchange it belongs to. At the foot of
                        the entry it sat nearer the NEXT question than its own
                        answer, and a scrolled box opened on an orphaned time. */}
                    <p className="px-1 text-right text-2xs text-ink-subtle">
                      <time dateTime={entry.createdAt}>{dateTime(entry.createdAt, locale)}</time>
                    </p>
                    <div className="flex justify-end">
                      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand-tint px-4 py-2.5 text-sm leading-6 text-ink">
                        {entry.channel === "voice" ? (
                          <>
                            <MicIcon aria-hidden className="mr-1.5 inline align-[-2px] text-base text-brand-ink" />
                            <span className="sr-only">{t("assistant.threadSpoken", locale)}: </span>
                          </>
                        ) : null}
                        {entry.input ?? t("assistant.threadNoInput", locale)}
                      </p>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-edge-soft bg-surface px-4 py-2.5 text-sm leading-6 text-ink shadow-xs">
                        {look ? (
                          <StatusBadge label={threadStatusLabel(shown, locale)} tone={look.tone} shape={look.shape} />
                        ) : null}
                        {entry.response ? (
                          <p className={cn("whitespace-pre-wrap", look && "mt-1.5")}>{entry.response}</p>
                        ) : null}
                        {entry.href || reviewable ? (
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            {entry.href ? (
                              <Link href={entry.href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                                {t("assistant.openRecord", locale)}
                              </Link>
                            ) : null}
                            {reviewable ? (
                              <Button size="sm" disabled={isBusy || isListening} onClick={() => reviewEntry(entry)}>
                                {t("assistant.threadReview", locale)}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      ) : null}

      {error ? (
        <div>
          <h2 ref={resultRegionRef} tabIndex={-1} className="sr-only">{t("assistant.needsAttention", locale)}</h2>
          <Flash tone="error" message={error} />
        </div>
      ) : null}

      {turn?.kind === "clarify" ? (
        <Card>
          <h2 ref={error ? undefined : resultRegionRef} tabIndex={-1} className="text-base font-semibold text-sand-900">{t("assistant.missingTitle", locale)}</h2>
          <p className="mt-1 text-sm text-sand-600">{turn.question}</p>
          <Button className="mt-3" size="sm" variant="secondary" loading={phase === "speaking"} onClick={() => void readAloud(turn.question)}>
            {t("assistant.readAloud", locale)}
          </Button>
          <div className="mt-4 space-y-4">
            {turn.fields.map((field) => (
              <Field key={field.name} label={field.label} htmlFor={`assistant-${field.name}`} required>
                {field.type === "select" ? (
                  <Select
                    id={`assistant-${field.name}`}
                    value={fieldValues[field.name] ?? ""}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  >
                    <option value="">{t("assistant.choose", locale)}</option>
                    {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                ) : (
                  <Input
                    id={`assistant-${field.name}`}
                    type={field.type}
                    min={field.type === "number" ? field.min : undefined}
                    step={field.type === "number" ? field.step : undefined}
                    value={fieldValues[field.name] ?? ""}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={isBusy} onClick={() => void reset()}>{t("common.cancel", locale)}</Button>
            <Button loading={phase === "interpreting"} disabled={isBusy && phase !== "interpreting"} onClick={() => void submitClarification()}>{t("assistant.continue", locale)}</Button>
          </div>
        </Card>
      ) : null}

      {turn?.kind === "confirm" ? (
        <Card className="border-brand-200 bg-brand-tint/30">
          <h2 ref={error ? undefined : resultRegionRef} tabIndex={-1} className="text-base font-semibold text-sand-900">{turn.proposal.title}</h2>
          <p className="mt-1 text-sm text-sand-600">{t("assistant.confirmExplain", locale)}</p>
          <p className="mt-1 text-xs text-sand-500">{t("assistant.proposalExpiry", locale)}</p>
          <Button className="mt-3" size="sm" variant="secondary" loading={phase === "speaking"} onClick={() => void readAloud(confirmationSpeechText ?? turn.proposal.title)}>
            {t("assistant.readAloud", locale)}
          </Button>
          <dl className="mt-4 divide-y divide-sand-200 rounded-lg border border-sand-200 bg-surface px-4">
            {turn.proposal.facts.map((fact) => (
              <div key={fact.label} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
                <dt className="text-sm font-medium text-sand-500">{fact.label}</dt>
                <dd className="whitespace-pre-wrap text-sm font-semibold text-sand-900">{fact.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={isBusy} onClick={() => void confirmProposal("reject")}>{t("assistant.doNotSave", locale)}</Button>
            <Button loading={phase === "committing"} disabled={isBusy && phase !== "committing"} onClick={() => void confirmProposal("confirm")}>{t("assistant.confirmSave", locale)}</Button>
          </div>
        </Card>
      ) : null}

      {turn?.kind === "needs_consent" ? (
        <Card className="border-callout-info-edge bg-callout-info-bg/40">
          <h2 ref={error ? undefined : resultRegionRef} tabIndex={-1} className="text-base font-semibold text-sand-900">{t("assistant.consentTitle", locale)}</h2>
          <p className="mt-2 text-sm leading-6 text-sand-700">{turn.explanation}</p>
          <p className="mt-2 text-xs leading-5 text-sand-500">{t("assistant.consentBody", locale)}</p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={isBusy} onClick={() => { setTurn(null); setPhase("idle"); }}>{t("assistant.consentSkip", locale)}</Button>
            <Button loading={consentUpdating} disabled={isBusy && !consentUpdating} onClick={() => void updateAiConsent(true)}>{t("assistant.consentAllow", locale)}</Button>
          </div>
        </Card>
      ) : null}

      {answerText ? (
        <Card className="border-callout-ok-edge bg-callout-ok-bg/50">
          <h2 ref={error ? undefined : resultRegionRef} tabIndex={-1} className="text-base font-semibold text-sand-900">{completion
            ? confirmedActionRef.current === "reject"
              ? t("assistant.threadRejected", locale)
              : t("assistant.successTitle", locale)
            : t("assistant.answerTitle", locale)}</h2>
          <p className="mt-2 text-sm leading-6 text-sand-800">{answerText}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" loading={phase === "speaking"} onClick={() => void readAloud(answerSpeechText ?? answerText)}>{t("assistant.readAloud", locale)}</Button>
            {turn?.kind === "answer" && turn.action ? (
              <Link href={turn.action.href} className={buttonVariants()}>{turn.action.label}</Link>
            ) : null}
            {completion?.href ? <Link href={completion.href} className={buttonVariants()}>{t("assistant.openRecord", locale)}</Link> : null}
            <Button variant="ghost" onClick={() => void reset()}>{t("assistant.newRequest", locale)}</Button>
          </div>
        </Card>
      ) : null}

      {/* Starters, shown only while there is nothing to read yet — the same
          reason a chat app hides its suggestions after the first message. */}
      {!turn && !transcript && !completion && visibleThread.length === 0 ? (
      <Card>
        <CardTitle>{t("assistant.examplesTitle", locale)}</CardTitle>
        <div className="mt-3 flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              disabled={isBusy || isListening}
              onClick={() => setTypedInput(example)}
              className="focus-ring min-h-[48px] rounded-full border border-sand-300 bg-surface px-4 py-2 text-left text-sm text-sand-700 hover:border-brand-300 hover:bg-brand-tint disabled:cursor-not-allowed disabled:opacity-50"
            >
              “{example}”
            </button>
          ))}
        </div>
      </Card>
      ) : null}

      {/* ── Composer ───────────────────────────────────────────────────────
          Was a titled form — a field labelled "Request" and a button reading
          "Interpret request" — which is why it read as paperwork rather than an
          assistant. It is now one composer at the foot of the column with the
          microphone inside it: the arrangement every assistant people already
          use has trained them on, so none of it needs explaining.

          The mic stays a filled 56px circle. This is a voice-first product for
          someone in a cab wearing gloves, and the documented touch floor is
          48px; shrinking it to a neat inline glyph would be a regression
          dressed as tidiness. */}
      {/* Not sticky. Pinned to the viewport it sat ON TOP of the thread and hid
          exactly the newest exchanges the thread scrolls into view. In flow, the
          thread's own scroll region ends directly above it — the arrangement a
          chat uses — and nothing is covered. */}
      <Card className="shadow-soft">
        <div
          aria-live="polite"
          aria-atomic="true"
          className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
        >
          <span className="text-sm font-semibold text-ink">{phaseLabel(phase, locale)}</span>
          <span className="text-xs text-ink-muted">
            {online ? t("assistant.audioPrivacy", locale) : t("assistant.offlinePrivacy", locale)}
          </span>
        </div>

        {/* What was heard, editable before it is acted on. This is the product's
            real safeguard and it stays exactly where the sending happens. */}
        {transcript ? (
          <div className="mb-3 border-b border-edge-soft pb-3">
            <Field
              label={t("assistant.transcriptLabel", locale)}
              htmlFor="assistant-transcript"
              hint={t("assistant.transcriptHint", locale)}
            >
              <Textarea
                id="assistant-transcript"
                rows={3}
                value={transcript}
                disabled={isListening || isBusy}
                onChange={(event) => updateTranscript(event.target.value)}
              />
            </Field>
            {pendingTranscript ? (
              <Button
                className="mt-3"
                loading={phase === "interpreting"}
                disabled={!transcript.trim() || (phase !== "idle" && phase !== "error")}
                onClick={() => void interpretTranscript()}
              >
                {t("assistant.interpretTranscript", locale)}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <label htmlFor="assistant-typed" className="sr-only">
            {t("assistant.typeLabel", locale)}
          </label>
          <Textarea
            id="assistant-typed"
            rows={2}
            className="flex-1"
            value={typedInput}
            placeholder={t("assistant.typePlaceholder", locale)}
            disabled={isBusy || isListening}
            onChange={(event) => setTypedInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends and Shift+Enter breaks the line, which is what every
              // assistant does. Ctrl/⌘+Enter is kept because it already worked
              // and somebody may have learned it. `isComposing` guards an IME:
              // committing a candidate with Enter must not send the message.
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void submitTyped();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitTyped();
              }
            }}
          />

          <button
            type="button"
            aria-label={isListening ? t("assistant.tapToStop", locale) : t("assistant.tapToSpeak", locale)}
            aria-pressed={isListening}
            disabled={isBusy}
            onClick={() => void (isListening ? stopListening() : startListening())}
            className={cn(
              "focus-ring flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-2xl text-white shadow-xs transition-colors",
              isListening
                ? "animate-pulse bg-status-overdue hover:bg-danger-600"
                : "bg-brand-600 hover:bg-brand-700 active:bg-brand-800",
              isBusy && "cursor-not-allowed opacity-50",
            )}
          >
            {isListening ? <StopIcon /> : <MicIcon />}
          </button>

          <button
            type="button"
            aria-label={t("assistant.sendTranscript", locale)}
            disabled={!typedInput.trim() || (phase !== "idle" && phase !== "error")}
            onClick={() => void submitTyped()}
            className={cn(
              "focus-ring flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl transition-colors",
              typedInput.trim() && (phase === "idle" || phase === "error")
                ? "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800"
                : "bg-surface-sunken text-ink-subtle",
              "disabled:cursor-not-allowed",
            )}
          >
            <SendIcon />
          </button>
        </div>

        <p className="mt-2 text-xs leading-5 text-ink-muted">{t("assistant.typeHint", locale)}</p>

        {/* Always present, not folded into the starters: the ordinary screens
            are the fallback when the assistant cannot help, and withdrawing AI
            permission has to stay reachable once a conversation has begun —
            which is precisely when somebody might want to withdraw it. */}
        <div className="mt-4 border-t border-edge-soft pt-3">
          <p className="text-xs leading-5 text-ink-muted">
            {t("assistant.manualFallback", locale)}{" "}
            <Link href="/faults" className="font-semibold text-brand-ink underline">
              {t("nav.faults", locale)}
            </Link>{" "}
            ·{" "}
            <Link href="/machines" className="font-semibold text-brand-ink underline">
              {t("nav.machines", locale)}
            </Link>
          </p>
          {aiConsent ? (
            <div className="mt-3 flex flex-col items-start gap-2">
              <p className="text-xs leading-5 text-ink-muted">{t("assistant.aiConsentActive", locale)}</p>
              <Button
                size="sm"
                variant="ghost"
                loading={consentUpdating}
                disabled={isBusy && !consentUpdating}
                onClick={() => void updateAiConsent(false)}
              >
                {t("assistant.consentWithdraw", locale)}
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
