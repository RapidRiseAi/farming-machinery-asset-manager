"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { Flash } from "@/components/ui/flash";
import { Input } from "@/components/ui/input";
import { HeadsetIcon, MicIcon, StopIcon, SendIcon } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/components/ui/cn";
import { StatusBadge, type StatusBadgeProps } from "@/components/ui/badge";
import { dateTime } from "@/lib/format";
import { groupThread } from "@/lib/assistant/thread";
import type { ThreadEntry, ThreadStatus } from "@/lib/assistant/thread";
import { langOf, t, toneOf, type Lang } from "@/lib/i18n";
import type {
  AssistantClarification,
  AssistantConfirmResponse,
  AssistantMachine,
  AssistantTurnRequest,
  AssistantTurnResponse,
  AssistantHearing,
  AssistantLocale,
  ConfirmationProposal,
} from "@/lib/assistant/types";
import {
  freshVoiceRetryFor,
  pendingTranscriptFor,
  type PendingAssistantTranscript,
} from "@/lib/assistant/voice-retry";
import { recognitionLocales, speechVocabulary, voiceForLocale } from "@/lib/assistant/speech-plan";
import { matchMachine } from "@/lib/assistant/normalize";
import { planAssistantRoute } from "@/lib/assistant/routing";
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
/**
 * Hands-free turn taking. Azure closes a phrase after a short silence; this is the
 * FURTHER quiet that means the person has finished, rather than paused for breath in
 * "log... 4300 hours on the... green tractor". Shorter answers sooner and cuts more
 * people off mid-sentence; "Done, answer now" skips the wait for anyone in a hurry.
 */
const VOICE_SETTLE_MS = 1_300;
/**
 * No NEW words for this long after something was said: finished, even though Azure has not
 * closed the phrase. In a cab or beside a tractor Azure hears the engine as sound, not
 * silence, so it may never close one, and the turn used to wait for the Done button.
 * Longer than the settle, so an ordinary turn still ends on Azure's own phrase end.
 */
const VOICE_QUIET_MS = 2_500;
/** Nothing at all said this long after listening starts: pause rather than keep a live mic. */
const VOICE_FIRST_WORDS_MS = 8_000;
/** A machine match this good, from the live transcript alone, is sent without a second hearing. */
const CONFIDENT_MATCH = 0.75;
/** Below this, a read names no machine at all: a fleet question, not a garbled name. */
const NO_MACHINE_NAMED = 0.45;
/** Azure re-hearing a short clip took about 1 s in testing; the AI models 2.5 to 6.5 s. */
const SECOND_HEARING_DEADLINE_MS = 6_000;
const AI_HEARING_DEADLINE_MS = 6_500;
/**
 * Once the AI hearing is in, the second pass is only an alternative for the server to
 * weigh, so it gets this much longer rather than the rest of its deadline. The ledger
 * measured the AI hearing at 0.9 s median (2026-10-09); the turn used to wait for both.
 */
const SECOND_HEARING_GRACE_MS = 400;

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

/** The hands-free panel's one line of status. */
function voicePhaseLabel(phase: Phase, waitingForTap: boolean, locale: Lang): string {
  switch (phase) {
    case "requesting_permission":
      return t("assistant.requestingMic", locale);
    case "listening":
      return t("assistant.voice.listening", locale);
    case "stopping":
    case "interpreting":
      return t("assistant.voice.thinking", locale);
    case "speaking":
      return t("assistant.voice.speaking", locale);
    case "committing":
      return t("assistant.voice.saving", locale);
    case "error":
      return t("assistant.needsAttention", locale);
    default:
      return waitingForTap ? t("assistant.voice.waitingForTap", locale) : t("assistant.ready", locale);
  }
}

/** A proposal as one spoken passage: what will be saved, then every fact, in order. */
function proposalReadBack(proposal: ConfirmationProposal): string {
  return [proposal.title, ...proposal.facts.map((fact) => `${fact.label}: ${fact.value}`)].join(". ");
}

export function AssistantClient({
  locale,
  offlineContextKey,
  initialSpeechLanguage,
  machines,
  initialAiConsent,
  initialNoticeSeen,
  initialAiWithdrawn,
  farmAiEnabled,
  capabilities,
  initialThread,
  infoButton,
}: {
  locale: Lang;
  offlineContextKey: string;
  initialSpeechLanguage: AssistantLocale;
  machines: AssistantMachine[];
  /** AI help is on for this person (assistant/transcription.ts aiHelpOn): the AI hearing and answers may run. */
  initialAiConsent: boolean;
  /** The AI notice has been dismissed. Until it is, the microphone waits and the notice shows. */
  initialNoticeSeen: boolean;
  /** This person switched AI help off. Their no stands: the notice tells them it is off and offers switching on. */
  initialAiWithdrawn: boolean;
  /** The owner's farm-wide AI switch. Off: no notice, no AI hearing, nothing to switch per person. */
  farmAiEnabled: boolean;
  capabilities: Capabilities;
  /** Past exchanges on this farm, oldest first, read through RLS by the page. */
  initialThread: ThreadEntry[];
  /**
   * "What is this?", rendered by the server page (it is a server component). When it is
   * there, the lead paragraph and the typing hint live in its panel instead of above and
   * below the composer, which is what kept the mic under a phone's first screen.
   */
  infoButton?: ReactNode;
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
  const [noticeSeen, setNoticeSeen] = useState(initialNoticeSeen);
  const [aiWithdrawn, setAiWithdrawn] = useState(initialAiWithdrawn);
  /** AI did not run because of a limit or a switch: said calmly, not as a failure. */
  const [pausedNotice, setPausedNotice] = useState<string | null>(null);
  /** The last request needs AI and waits on the notice: sent as soon as the person is told. */
  const [noticeWaiting, setNoticeWaiting] = useState(false);
  // Nothing goes to an AI on a farm whose owner switched AI off, so there is nothing to be
  // told about yet; elsewhere the notice comes first.
  const noticeNeeded = farmAiEnabled && !noticeSeen;
  const aiHelpActive = farmAiEnabled && aiConsent;
  const noticeNeededRef = useRef(noticeNeeded);
  useEffect(() => {
    noticeNeededRef.current = noticeNeeded;
  }, [noticeNeeded]);
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
  /** The AI notice card, brought into view when someone reaches for the mic first. */
  const noticeRef = useRef<HTMLHeadingElement | null>(null);
  const [noticeSaving, setNoticeSaving] = useState(false);
  const operationRef = useRef(0);
  const mountedRef = useRef(true);

  // == Hands-free voice mode ================================================
  // A loop of listen, answer aloud, listen again. Every step continues after an
  // await that began renders ago, so the loop never trusts `phase` or `turn` from
  // its closure: it carries a session number, and stopping (or stopping and
  // starting again) bumps the number so every orphaned continuation goes quiet.
  const [voiceMode, setVoiceMode] = useState(false);
  /** Why hands-free paused on its own, shown until the next request. */
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const voiceModeRef = useRef(false);
  const voiceSessionRef = useRef(0);
  const voiceSettleTimerRef = useRef<number | null>(null);
  const voiceFirstWordsTimerRef = useRef<number | null>(null);
  const voiceQuietTimerRef = useRef<number | null>(null);
  /** Times the current spoken follow-up was not an answer; asked again once, then typed. */
  const voiceRetryRef = useRef(0);
  const finishVoiceTurnRef = useRef<(operation: number) => Promise<void>>(async () => undefined);

  // == The thread =========================================================
  // Past exchanges. The LIVE exchange is not in here: it keeps rendering as the
  // cards below until the live area clears, and only then moves up into the
  // thread (see the transition effect). An exchange is therefore always in
  // exactly one place, which is what stops it rendering twice.
  const [thread, setThread] = useState<ThreadEntry[]>(initialThread);
  // Runs of abandoned attempts the person has chosen to open, by the id of the
  // first entry in the run. Folded by default: a heavily used thread fills with
  // identical "Expired" lines, and the exchanges that did something scroll away
  // behind them.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
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
      voiceModeRef.current = false;
      voiceSessionRef.current += 1;
      for (const timer of [voiceSettleTimerRef, voiceFirstWordsTimerRef, voiceQuietTimerRef]) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
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
    voiceModeRef.current = false;
    voiceSessionRef.current += 1;
    for (const timer of [voiceSettleTimerRef, voiceFirstWordsTimerRef, voiceQuietTimerRef]) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    }
    setVoiceMode(false);
    setVoiceNotice(null);
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
    setNoticeSeen(initialNoticeSeen);
    setAiWithdrawn(initialAiWithdrawn);
    setPausedNotice(null);
    setNoticeWaiting(false);
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
  }, [initialAiConsent, initialNoticeSeen, initialAiWithdrawn, initialSpeechLanguage, offlineContextKey]);

  useEffect(() => {
    if (turn || completion || error) {
      const timer = window.setTimeout(() => resultRegionRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [turn, completion, error]);

  /**
   * Hands-free means nobody touches the screen, so without this the phone locks
   * mid-conversation and takes the microphone with it. Held only while hands-free is
   * on; the browser drops it whenever the page is hidden, so it is taken again on return.
   */
  useEffect(() => {
    if (!voiceMode || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let active = true;
    const hold = async () => {
      if (document.visibilityState !== "visible" || (sentinel && !sentinel.released)) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (active) sentinel = next;
        else void next.release().catch(() => undefined);
      } catch {
        // Refused (low battery, an embedding frame): the phone may sleep, nothing worse.
      }
    };
    void hold();
    const onVisibility = () => void hold();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
    };
  }, [voiceMode]);

  useEffect(() => {
    if (turn?.kind !== "clarify") return;
    const initial: Record<string, string> = {};
    for (const field of turn.fields) {
      if (field.type !== "select" && field.value != null) initial[field.name] = String(field.value);
    }
    setFieldValues(initial);
  }, [turn]);

  /**
   * Moves the live exchange into the thread when, and only when, the live area
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

  /** Resolves to the reply it showed, or null when there was none to act on (failure, superseded). */
  const submitRequest = useCallback(
    async (requestBody: AssistantTurnRequest): Promise<AssistantTurnResponse | null> => {
      if (requestAbortRef.current) return null;
      setVoiceNotice(null);
      const retryTranscript = requestBody.clarification ? null : pendingTranscriptFor(requestBody);
      if (!navigator.onLine) {
        if (retryTranscript) setPendingTranscript(retryTranscript);
        setPhase("error");
        setError(t("assistant.offlineTyped", locale));
        return null;
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
      setPausedNotice(null);
      setNoticeWaiting(false);
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
        if (!mountedRef.current || operation !== operationRef.current) return null;
        if (response.ok && next.kind === "error" && next.code === "ai_paused") {
          setTurn(null);
          if (next.reason === "notice_required" && noticeNeededRef.current) {
            // Waiting on the notice, not paused: the notice is brought into view and this
            // request is sent the moment the person has been told (acknowledgeNotice).
            setNoticeWaiting(true);
          } else {
            // A limit or a switch, not a failure: said calmly, and typing still works.
            setPausedNotice(next.message);
          }
          setPhase("idle");
          return null;
        }
        setTurn(next);
        if (!response.ok || next.kind === "error") {
          if (retryTranscript) setPendingTranscript(freshVoiceRetryFor(requestBody) ?? retryTranscript);
          setError(next.kind === "error" ? next.message : t("assistant.serviceUnavailable", locale));
          setPhase("error");
          return null;
        }
        setPhase("idle");
        return next;
      } catch {
        if (!mountedRef.current || operation !== operationRef.current) return null;
        if (retryTranscript) setPendingTranscript(freshVoiceRetryFor(requestBody) ?? retryTranscript);
        setError(t(timedOut ? "assistant.requestTimedOut" : "assistant.serviceUnavailable", locale));
        setPhase("error");
        return null;
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

  /** A hands-free continuation may act only while ITS session is still the live one. */
  const voiceSessionIsLive = (session: number) =>
    mountedRef.current && voiceModeRef.current && session === voiceSessionRef.current;

  const clearVoiceTimers = () => {
    for (const timer of [voiceSettleTimerRef, voiceFirstWordsTimerRef, voiceQuietTimerRef]) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  /**
   * Leaves hands-free. What is on screen stays: a confirmation card still waits for
   * its tap and an answer can still be read. Only the loop stops.
   */
  const endVoiceMode = (notice: string | null = null) => {
    voiceModeRef.current = false;
    voiceSessionRef.current += 1;
    clearVoiceTimers();
    setVoiceMode(false);
    setVoiceNotice(notice);
  };

  /**
   * `voiceSession` marks a hands-free turn. It starts from a callback that closed over
   * an earlier render, so it is gated on its session rather than on a stale `phase`,
   * and the clarification it answers is handed in rather than read from a stale `turn`.
   */
  const startListening = async (options: { voiceSession?: number; followUp?: ClarifyTurn | null } = {}) => {
    const { voiceSession } = options;
    const voice = voiceSession !== undefined;
    if (recordingRequestedRef.current) return;
    // Told before anything is heard by an AI (POPIA s18): the notice first, then the
    // microphone. Offline, a recording stays on the phone until it is sent, so it waits
    // for nothing (and AI cannot hear it until the notice is seen online).
    if (noticeNeeded && navigator.onLine) {
      showNotice();
      return;
    }
    if (voiceSession !== undefined ? !voiceSessionIsLive(voiceSession) : phase !== "idle" && phase !== "error") return;
    if (voice && !navigator.onLine) {
      endVoiceMode(t("assistant.voice.offline", locale));
      return;
    }
    recordingRequestedRef.current = true;
    const operation = ++operationRef.current;
    const followUp = voice ? options.followUp ?? null : turn?.kind === "clarify" ? turn : null;
    const spokenFollowUp = navigator.onLine && followUp && followUp.fields.length === 1 && lastRequestRef.current
      ? { turn: followUp, field: followUp.fields[0], request: lastRequestRef.current }
      : null;
    spokenClarificationRef.current = spokenFollowUp;
    setVoiceNotice(null);
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
        // Kept in memory for this turn only, in case the words need hearing again.
        captureClip: true,
        onPartial: (result) => {
          if (!mountedRef.current || operation !== operationRef.current) return;
          const prefix = finalSegmentsRef.current.join(" ");
          const value = `${prefix}${prefix ? " " : ""}${result.text}`.trim();
          const newWords = value !== transcriptRef.current;
          transcriptRef.current = value;
          setTranscript(value);
          // New words: still talking, so neither "said nothing" nor "finished". A partial
          // that only repeats what was already heard is not more speech.
          if (voice && newWords) {
            clearVoiceTimers();
            // Azure may never close the phrase over engine noise: no new words for
            // VOICE_QUIET_MS means finished all the same (the Done button is not needed).
            if (value && voiceSessionIsLive(voiceSession) && recordingRequestedRef.current) {
              voiceQuietTimerRef.current = window.setTimeout(() => {
                voiceQuietTimerRef.current = null;
                void finishVoiceTurnRef.current(operation);
              }, VOICE_QUIET_MS);
            }
          }
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
          // Not once the turn is already finishing: a phrase Azure closes during the
          // stop still joins the transcript, but must not arm a second finish.
          if (voiceSession !== undefined && voiceSessionIsLive(voiceSession) && recordingRequestedRef.current) {
            clearVoiceTimers();
            voiceSettleTimerRef.current = window.setTimeout(() => {
              voiceSettleTimerRef.current = null;
              void finishVoiceTurnRef.current(operation);
            }, VOICE_SETTLE_MS);
          }
        },
        onNoMatch: () => {
          // In a cab, engine noise is a no-match every few seconds. Hands-free ignores
          // it and lets the first-words timer decide whether anything was said.
          if (voice) return;
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
          if (voice) endVoiceMode();
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
      // A hands-free stop can land while the recogniser is still starting; it arms nothing then.
      const stillWanted = voiceSession === undefined || voiceSessionIsLive(voiceSession);
      if (mountedRef.current && operation === operationRef.current && stillWanted) {
        liveRecordingTimerRef.current = window.setTimeout(() => {
          void (voice ? finishVoiceTurnRef.current(operation) : stopListeningRef.current());
        }, MAX_OFFLINE_RECORDING_MS);
        if (voice && !transcriptRef.current) {
          voiceFirstWordsTimerRef.current = window.setTimeout(() => {
            voiceFirstWordsTimerRef.current = null;
            void finishVoiceTurnRef.current(operation);
          }, VOICE_FIRST_WORDS_MS);
        }
      }
    } catch (caught) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      recordingRequestedRef.current = false;
      if (liveRecordingTimerRef.current !== null) {
        window.clearTimeout(liveRecordingTimerRef.current);
        liveRecordingTimerRef.current = null;
      }
      if (voice) endVoiceMode();
      const message = caught instanceof SpeechClientError
        ? speechErrorMessage(caught, locale)
        : t("assistant.recognitionFailed", locale);
      setError(message);
      setPhase("error");
    }
  };

  /** What the live recogniser heard, as a voice request ready to send. */
  const heardTranscript = (): PendingAssistantTranscript => ({
    locale: speechLanguage,
    channel: "voice",
    voiceCaptureId: captureIdRef.current ?? crypto.randomUUID(),
    sttConfidence: confidenceWeightRef.current > 0
      ? confidenceTotalRef.current / confidenceWeightRef.current
      : undefined,
  });

  /**
   * Whether the live transcript can carry the request on its own: an intent and one
   * confident machine, or a fleet question that names none. Then it goes at once, with
   * no added wait; only the hard turns are heard again (see `gatherHearings`).
   */
  const liveTranscriptResolves = (text: string): boolean => {
    const plan = planAssistantRoute(text, speechLanguage);
    if (plan.kind === "optional_ai") return false;
    const match = matchMachine(text, machines);
    if (match.machine && !match.ambiguous && match.score >= CONFIDENT_MATCH) return true;
    // A garbled name ("the Spitfire" for Spuitwa) also scores low, so a weak match alone
    // is not "no machine named": the sentence must not point at one either.
    const lower = text.toLocaleLowerCase("en-ZA");
    const pointsAtMachine = /\b(?:of|on|for|about|with|op|vir|van|oor|met)\s+(?:the|die)\s+\S/.test(lower)
      || /\b(?:die|the)\s+\S+(?:\s+\S+)?\s+se\b/.test(lower);
    return plan.kind === "local" && !match.ambiguous && match.score < NO_MACHINE_NAMED && !pointsAtMachine;
  };

  const fetchAiHearings = async (clip: File, signal: AbortSignal): Promise<string[]> => {
    try {
      // The chosen language goes with the clip, so an English speaker is heard in English.
      const response = await fetch(`/api/assistant/transcribe?locale=${encodeURIComponent(speechLanguage)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "audio/wav" },
        body: clip,
        signal,
      });
      if (!response.ok) return [];
      const body = (await response.json().catch(() => null)) as { hearings?: Array<{ text?: unknown }> } | null;
      return (body?.hearings ?? [])
        .map((hearing) => (typeof hearing.text === "string" ? hearing.text.trim() : ""))
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  /**
   * Hears a hard turn again from the clip recorded alongside the live transcript: Azure
   * in the other fixed language, in South Africa North, for everyone; and with audio
   * consent, the AI transcribers told the farm's machine names. Each language model keeps
   * what the other loses, and the server weighs every hearing (routing.ts). With an AI
   * hearing, that becomes the transcript shown, because it measured far closer to what
   * was said. Every source has a deadline, so a slow one never holds the turn up.
   */
  const gatherHearings = async (
    live: string,
    operation: number,
  ): Promise<{ input: string; alternatives: AssistantHearing[] }> => {
    const plain = { input: live, alternatives: [] as AssistantHearing[] };
    // Decide first: decoding the clip costs a phone real work, and an easy turn needs none.
    if (!navigator.onLine || liveTranscriptResolves(live)) {
      getSpeech().discardLastClip();
      return plain;
    }
    const clip = await getSpeech().takeLastClip();
    if (!clip || operation !== operationRef.current) return plain;

    const otherLocale: AssistantLocale = speechLanguage === "af-ZA" ? "en-ZA" : "af-ZA";
    const controller = new AbortController();
    const deadline = <T,>(work: Promise<T>, ms: number, fallback: T) =>
      Promise.race([work, new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms))]);
    const secondWork = deadline(
      getSpeech()
        .recognizeFile(clip, {
          locale: otherLocale,
          autoDetectLocales: [otherLocale],
          phrases: otherLocale === "en-ZA" ? machineVocabulary : undefined,
        })
        .catch(() => ""),
      SECOND_HEARING_DEADLINE_MS,
      "",
    );
    const ai = aiHelpActive
      ? await deadline(fetchAiHearings(clip, controller.signal), AI_HEARING_DEADLINE_MS, [] as string[])
      : [];
    const second = ai.length ? await deadline(secondWork, SECOND_HEARING_GRACE_MS, "") : await secondWork;
    controller.abort();
    if (operation !== operationRef.current) return plain;

    const alternatives: AssistantHearing[] = [];
    let input = live;
    if (ai.length) {
      input = ai[0];
      for (const text of ai.slice(1)) alternatives.push({ text, locale: speechLanguage, source: "ai" });
      alternatives.push({ text: live, locale: speechLanguage, source: "recogniser" });
    }
    if (second.trim()) alternatives.push({ text: second.trim(), locale: otherLocale, source: "second-pass" });
    return { input, alternatives: alternatives.slice(0, 4) };
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
      const operation = operationRef.current;
      const heard = await gatherHearings(input, operation);
      if (!mountedRef.current || operation !== operationRef.current) return;
      if (heard.input !== input) {
        transcriptRef.current = heard.input;
        setTranscript(heard.input);
      }
      setPendingTranscript({ ...heardTranscript(), alternatives: heard.alternatives.length ? heard.alternatives : undefined });
      lastRequestRef.current = null;
      setPhase("idle");
    } catch {
      setError(t("assistant.recognitionFailed", locale));
      setPhase("error");
    }
  };
  stopListeningRef.current = stopListening;

  /**
   * Speaks one hands-free reply. True means carry on: it finished, or was talked
   * over. False means the sound failed, and the loop has stopped with the reason on
   * screen.
   */
  const speakInVoiceMode = async (text: string, session: number): Promise<boolean> => {
    if (!voiceSessionIsLive(session)) return false;
    if (!text.trim()) return true;
    const operation = ++operationRef.current;
    speechInFlightRef.current = true;
    setPhase("speaking");
    try {
      await getSpeech().speak(text, { voice: voiceForLocale(lastRequestRef.current?.locale ?? speechLanguage) });
      return true;
    } catch (caught) {
      if (caught instanceof SpeechClientError && caught.code === "cancelled") return true;
      if (mountedRef.current && operation === operationRef.current && voiceSessionIsLive(session)) {
        endVoiceMode();
        setError(caught instanceof SpeechClientError ? speechErrorMessage(caught, locale) : t("assistant.speechFailed", locale));
        setPhase("error");
      }
      return false;
    } finally {
      speechInFlightRef.current = false;
      if (mountedRef.current && operation === operationRef.current) {
        setPhase((current) => (current === "speaking" ? "idle" : current));
      }
    }
  };

  const speakThenListen = async (text: string, session: number, followUp: ClarifyTurn | null) => {
    if ((await speakInVoiceMode(text, session)) && voiceSessionIsLive(session)) {
      await startListening({ voiceSession: session, followUp });
    }
  };

  /** What hands-free does with each kind of reply. */
  const afterVoiceResponse = async (next: AssistantTurnResponse | null, session: number) => {
    if (!voiceSessionIsLive(session)) return;
    voiceRetryRef.current = 0;
    if (!next || next.kind === "error") {
      // The failure is on screen. A loop that talks over it, or listens past it, helps nobody.
      endVoiceMode();
      return;
    }
    if (next.kind === "answer") {
      await speakThenListen(next.speakText ?? next.message, session, null);
      return;
    }
    if (next.kind === "clarify") {
      if (next.fields.length === 1) {
        await speakThenListen(next.question, session, next);
        return;
      }
      // Several things to fill in is a form, and a form is for fingers.
      await speakInVoiceMode(next.question, session);
      if (voiceSessionIsLive(session)) endVoiceMode(t("assistant.voice.formPaused", locale));
      return;
    }
    if (next.kind === "confirm") {
      // Read it back, then wait: only a tap saves, and confirmProposal resumes the loop.
      // The closing prompt is in the language the reply was spoken in, not the screen's.
      const spoken = langOf((lastRequestRef.current?.locale ?? speechLanguage) === "af-ZA" ? "af" : "en", toneOf(locale));
      await speakInVoiceMode(
        `${proposalReadBack(next.proposal)}. ${t("assistant.voice.tapToConfirmSpoken", spoken)}`,
        session,
      );
      return;
    }
    // needs_consent: permission to use AI is given in writing, on screen.
    endVoiceMode();
  };

  /**
   * Ends a hands-free turn: what was heard goes straight to the assistant, with no
   * editing step. That is safe because nothing is saved from here: a change comes
   * back as the confirmation card, and only a tap on it saves.
   */
  const finishVoiceTurn = async (operation: number) => {
    const session = voiceSessionRef.current;
    if (!voiceSessionIsLive(session) || operation !== operationRef.current || !recordingRequestedRef.current) return;
    clearVoiceTimers();
    if (liveRecordingTimerRef.current !== null) {
      window.clearTimeout(liveRecordingTimerRef.current);
      liveRecordingTimerRef.current = null;
    }
    recordingRequestedRef.current = false;
    setPhase("stopping");
    await getSpeech().stopRecognition().catch(() => undefined);
    if (!mountedRef.current || operation !== operationRef.current) return;
    if (!voiceSessionIsLive(session)) {
      // Stopped while the last words were being finished: keep them, as Stop does,
      // and hand the screen back. Returning here without that left it on "Thinking".
      if (transcriptRef.current.trim()) {
        setPendingTranscript(heardTranscript());
        lastRequestRef.current = null;
      }
      setPhase("idle");
      return;
    }
    const live = transcriptRef.current.trim();
    if (!live) {
      endVoiceMode(t("assistant.voice.noSpeechPaused", locale));
      setPhase("idle");
      return;
    }
    const spokenFollowUp = spokenClarificationRef.current;
    // A spoken number or yes/no is heard well enough; a machine name is exactly what goes
    // wrong, so an answer to "which machine?" is heard again like a fresh request.
    const gathered = !spokenFollowUp || spokenFollowUp.field.name === "machineId"
      ? await gatherHearings(live, operation)
      : { input: live, alternatives: [] as AssistantHearing[] };
    if (!mountedRef.current || operation !== operationRef.current) return;
    const input = gathered.input;
    if (input !== live) {
      transcriptRef.current = input;
      setTranscript(input);
    }
    const heard = { ...heardTranscript(), alternatives: gathered.alternatives.length ? gathered.alternatives : undefined };
    if (!voiceSessionIsLive(session)) {
      // Stopped while the words were being heard again: keep them, as Stop does.
      setPendingTranscript(heard);
      lastRequestRef.current = null;
      setPhase("idle");
      return;
    }
    let request: AssistantTurnRequest = { ...heard, input };
    if (spokenFollowUp) {
      const clarification = clarificationFromSpeech(spokenFollowUp.turn.conversationId, spokenFollowUp.field, input);
      if (!clarification) {
        // Not an answer to what was asked: a reading with no number in it, say. The
        // question is still on screen. Ask it once more, then leave it to the keyboard.
        if (voiceRetryRef.current < 1) {
          voiceRetryRef.current += 1;
          await speakThenListen(spokenFollowUp.turn.question, session, spokenFollowUp.turn);
          return;
        }
        endVoiceMode();
        setError(t("assistant.fillRequired", locale));
        setPhase("error");
        return;
      }
      request = { ...spokenFollowUp.request, ...heard, input, clarification };
      delete request.supersedesVoiceCaptureIds;
      spokenClarificationRef.current = null;
    }
    const next = await submitRequest(request);
    await afterVoiceResponse(next, session);
  };
  finishVoiceTurnRef.current = finishVoiceTurn;

  const startVoiceMode = () => {
    if (voiceModeRef.current || recordingRequestedRef.current || !navigator.onLine) return;
    if (noticeNeeded) {
      showNotice();
      return;
    }
    if (phase !== "idle" && phase !== "error") return;
    // Synchronously, inside this tap and before any await: a phone plays only sound a
    // tap started, and every spoken reply arrives long after the tap.
    getSpeech().unlockAudio();
    voiceModeRef.current = true;
    voiceRetryRef.current = 0;
    const session = ++voiceSessionRef.current;
    setVoiceMode(true);
    setVoiceNotice(null);
    void startListening({ voiceSession: session, followUp: turn?.kind === "clarify" ? turn : null });
  };

  /** "Done, answer now": skip the quiet wait. */
  const sendVoiceNow = () => {
    if (!voiceModeRef.current || phase !== "listening") return;
    void finishVoiceTurn(operationRef.current);
  };

  /** Talk over the answer: stop speaking, and listen now. */
  const interruptVoice = () => {
    if (!voiceModeRef.current || phase !== "speaking") return;
    void getSpeech().stopSpeaking();
  };

  /** The panel's Stop. Anything already heard stays as an editable transcript, as with the microphone. */
  const stopVoiceMode = async () => {
    if (!voiceModeRef.current) return;
    endVoiceMode();
    if (recordingRequestedRef.current) {
      recordingRequestedRef.current = false;
      if (liveRecordingTimerRef.current !== null) {
        window.clearTimeout(liveRecordingTimerRef.current);
        liveRecordingTimerRef.current = null;
      }
      const operation = operationRef.current;
      setPhase("stopping");
      await getSpeech().stopRecognition().catch(() => undefined);
      if (!mountedRef.current || operation !== operationRef.current) return;
      if (transcriptRef.current.trim()) {
        setPendingTranscript(heardTranscript());
        lastRequestRef.current = null;
      }
      setPhase("idle");
      return;
    }
    if (speechInFlightRef.current) await getSpeech().stopSpeaking().catch(() => undefined);
  };

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
      else if (field.name === "litres") clarification.litres = Number(raw);
      else if (field.name === "tankId") clarification.tankId = raw;
    }
    const continuation = { ...previous, clarification };
    delete continuation.supersedesVoiceCaptureIds;
    await submitRequest(continuation);
  };

  const confirmProposal = async (action: "confirm" | "reject") => {
    // Hands-free reads the change back before the tap. A tap during that means the
    // person has read enough: it stops the voice and goes ahead, never waits it out.
    const tapOverReadBack = voiceModeRef.current && phase === "speaking";
    if (commitInFlightRef.current || turn?.kind !== "confirm") return;
    if (phase !== "idle" && phase !== "error" && !tapOverReadBack) return;
    commitInFlightRef.current = true;
    const operation = ++operationRef.current;
    setPhase("committing");
    setError(null);
    if (tapOverReadBack) await getSpeech().stopSpeaking().catch(() => undefined);
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
      // Hands-free: say what happened, then listen for the next thing.
      if (voiceModeRef.current) void speakThenListen(result.message, voiceSessionRef.current, null);
    } catch {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setError(t("assistant.saveFailed", locale));
      setPhase("error");
    } finally {
      commitInFlightRef.current = false;
    }
  };

  const showNotice = () => {
    noticeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    noticeRef.current?.focus({ preventScroll: true });
  };

  // A hard request came back needing AI help before the notice was seen: the notice is
  // where that choice is made, so bring it into view.
  const waitingForNotice = (turn?.kind === "needs_consent" || noticeWaiting) && noticeNeeded;
  useEffect(() => {
    if (!waitingForNotice) return;
    noticeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    noticeRef.current?.focus({ preventScroll: true });
  }, [waitingForNotice]);

  /**
   * The notice's two buttons (founder decision 10): "Got it" keeps AI help on, "Switch
   * off" turns it off. Either way the person has now been told, and the database records
   * it. For someone who had switched AI off, the database only records that they were
   * told: their no stands, and switching on is the separate, explicit button.
   */
  const acknowledgeNotice = async (keepOn: boolean) => {
    if (noticeSaving) return;
    setNoticeSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/assistant/notice", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ keepOn }),
      });
      if (!response.ok) throw new Error("notice_failed");
      const recorded = (await response.json().catch(() => null)) as { aiOn?: boolean; withdrawn?: boolean } | null;
      if (!mountedRef.current) return;
      const on = Boolean(recorded?.aiOn);
      setNoticeSeen(true);
      setAiConsent(on);
      setAiWithdrawn(!on && (Boolean(recorded?.withdrawn) || !keepOn));
      // A hard request was waiting for AI help: with AI on, send it now rather than ask again.
      const previous = lastRequestRef.current;
      const waiting = turn?.kind === "needs_consent" || noticeWaiting;
      setNoticeWaiting(false);
      if (on && waiting && previous && (phase === "idle" || phase === "error")) {
        const voiceRetry = freshVoiceRetryFor(previous);
        await submitRequest({ ...previous, ...(voiceRetry ?? {}), clarification: undefined });
      } else if (!on && turn?.kind === "needs_consent") {
        setTurn(null);
      }
    } catch {
      if (mountedRef.current) setError(t("assistant.noticeFailed", locale));
    } finally {
      if (mountedRef.current) setNoticeSaving(false);
    }
  };

  /**
   * AI help on or off for this person. `fromNotice`: the switch was pressed under the
   * notice's own text, so switching on also records that the person was told. Anywhere
   * else it records that only when the notice was already seen. What the database
   * recorded decides what the screen shows.
   */
  const updateAiConsent = async (allow: boolean, fromNotice = false) => {
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
        // `notice` only when the notice's text was on screen (consent/route.ts stamps it
        // only when asked), never for a switch the person reached without it.
        body: JSON.stringify({ allow, notice: allow && (fromNotice || noticeSeen) }),
      });
      if (!response.ok) throw new Error("consent_failed");
      const recorded = (await response.json().catch(() => null)) as
        | { ai_processing_opt_in?: boolean; ai_processing_consent_version?: string | null }
        | null;
      if (!mountedRef.current || operation !== operationRef.current) return;
      setAiConsent(Boolean(allow && recorded?.ai_processing_opt_in));
      setAiWithdrawn(!allow);
      // Switching on sits under the notice text, so it also counts as having been told.
      if (allow) setNoticeSeen(true);
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
    endVoiceMode();
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
  /** Hands-free is reading a change back: its card's two buttons stay live (see confirmProposal). */
  const readingBack = voiceMode && phase === "speaking" && turn?.kind === "confirm";
  // The live exchange's id, hidden from the thread while it is live so the same
  // exchange never shows twice, for instance a pending proposal being reviewed.
  const liveId =
    turn && "conversationId" in turn
      ? turn.conversationId
      : completion && lastProposalIdRef.current
        ? lastProposalIdRef.current
        : null;
  const visibleThread = liveId ? thread.filter((entry) => entry.id !== liveId) : thread;

  /**
   * The thread as rows to render: a folded run becomes one toggle, and its
   * entries appear only when opened. Flattened here so every row is a single
   * <li>, and computed outside the hook region because it is derived state.
   */
  type ThreadRow = { kind: "toggle"; id: string; count: number; open: boolean } | { kind: "entry"; entry: ThreadEntry };
  const threadRows: ThreadRow[] = [];
  for (const group of groupThread(visibleThread)) {
    if (group.kind === "entry") {
      threadRows.push({ kind: "entry", entry: group.entry });
      continue;
    }
    const open = openRuns.has(group.id);
    threadRows.push({ kind: "toggle", id: group.id, count: group.entries.length, open });
    if (open) for (const entry of group.entries) threadRows.push({ kind: "entry", entry });
  }

  // Keep the newest exchange in view, inside the thread's own scroll region -
  // never by moving the page, which would yank somebody away from what they
  // were reading.
  useEffect(() => {
    const el = threadScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleThread.length]);
  const answerText = turn?.kind === "answer" ? turn.message : completion?.message;
  const answerSpeechText = turn?.kind === "answer" ? (turn.speakText ?? turn.message) : completion?.message;
  const confirmationSpeechText = turn?.kind === "confirm" ? proposalReadBack(turn.proposal) : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {/* The language sits beside the title, as a setting of the whole screen, rather than
          as a full-width row between the title and the conversation: it is chosen once and
          rarely changed, and the row it took was the first thing on the page. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("assistant.title", locale)}</h1>
          {infoButton ? (
            <div className="mt-1">{infoButton}</div>
          ) : (
            <p className="mt-1 text-sm leading-6 text-sand-600">{t("assistant.lead", locale)}</p>
          )}
        </div>
        <div
          role="group"
          aria-label={t("assistant.languageLabel", locale)}
          aria-describedby="assistant-language-hint"
          className="inline-flex shrink-0 rounded-xl border border-sand-200 bg-sand-50 p-1"
        >
          {(["en-ZA", "af-ZA"] as const).map((language) => (
            <button
              key={language}
              type="button"
              disabled={isListening || isBusy || voiceMode}
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
                "focus-ring min-h-[48px] rounded-lg px-4 text-sm font-semibold transition-colors sm:min-h-[40px]",
                speechLanguage === language ? "bg-surface text-brand-ink shadow-xs" : "text-sand-600 hover:bg-white/70",
              )}
            >
              {language === "af-ZA" ? t("assistant.languageShortAf", locale) : t("assistant.languageShortEn", locale)}
            </button>
          ))}
        </div>
        <p id="assistant-language-hint" className="sr-only">{t("assistant.languageHint", locale)}</p>
      </header>
      {/* AI help is on by default, but nobody is heard by an AI before they have been told
          (POPIA s18; the server refuses until this is dismissed). Shown once, first. For
          someone who switched AI off it says so, and switching on is its own button. A
          hard request waiting for AI help is explained here, not in a second card. */}
      {noticeNeeded ? (
        <Card className="border-callout-info-edge bg-callout-info-bg/40">
          <h2 ref={noticeRef} tabIndex={-1} className="text-base font-semibold text-sand-900">
            {t(aiWithdrawn ? "assistant.noticeWithdrawnTitle" : "assistant.noticeTitle", locale)}
          </h2>
          {turn?.kind === "needs_consent" ? (
            <p className="mt-2 text-sm leading-6 text-sand-800">{turn.explanation}</p>
          ) : noticeWaiting ? (
            <p className="mt-2 text-sm leading-6 text-sand-800">{t("assistant.noticeWaiting", locale)}</p>
          ) : null}
          <p className="mt-2 text-sm leading-6 text-sand-700">
            {t(aiWithdrawn ? "assistant.noticeWithdrawnBody" : "assistant.noticeBody", locale)}
          </p>
          <p className="mt-2 text-xs leading-5 text-sand-500">{t("assistant.noticeBilling", locale)}</p>
          {aiWithdrawn ? (
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" disabled={noticeSaving || consentUpdating} onClick={() => void acknowledgeNotice(false)}>
                {t("assistant.noticeWithdrawnKeepOff", locale)}
              </Button>
              <Button loading={consentUpdating} disabled={noticeSaving || (isBusy && !consentUpdating)} onClick={() => void updateAiConsent(true, true)}>
                {t("assistant.noticeWithdrawnOn", locale)}
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" disabled={noticeSaving} onClick={() => void acknowledgeNotice(false)}>
                {t("assistant.noticeOff", locale)}
              </Button>
              <Button loading={noticeSaving} onClick={() => void acknowledgeNotice(true)}>
                {t("assistant.noticeKeep", locale)}
              </Button>
            </div>
          )}
        </Card>
      ) : null}

      {offlineCaptures.length > 0 ? (
        <Card className="border-callout-warn-edge bg-callout-warn-bg/50">
          <CardTitle>{t("assistant.offlineTitle", locale)}</CardTitle>
          <p className="mt-1 text-sm text-sand-700">
            {t(offlineCaptures.length === 1 ? "assistant.offlinePendingOne" : "assistant.offlinePending", locale).replace(
              "{count}",
              String(offlineCaptures.length),
            )}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={!online || isBusy || offlineProcessing || voiceMode}
              loading={offlineProcessing}
              onClick={() => void processOfflineCapture(offlineCaptures[0])}
            >
              {online ? t("assistant.offlineProcess", locale) : t("assistant.waitingForSignal", locale)}
            </Button>
            <Button
              variant="ghost"
              disabled={isBusy || offlineProcessing || voiceMode}
              onClick={() => void removeOfflineCaptures(offlineCaptures[0])}
            >
              {t("assistant.offlineDiscard", locale)}
            </Button>
            <Button
              variant="ghost"
              disabled={isBusy || offlineProcessing || voiceMode}
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
                subject's own rows, not a colleague's, not the farm owner's. */}
            <p className="text-xs text-ink-subtle">{t("assistant.threadPrivate", locale)}</p>
          </div>
          <div
            ref={threadScrollRef}
            tabIndex={0}
            aria-label={t("assistant.threadTitle", locale)}
            className="focus-ring max-h-64 overflow-y-auto rounded-xl border border-edge-soft bg-surface-sunken/40 p-3 sm:max-h-[28rem] sm:p-4"
          >
            <ol className="flex flex-col gap-5">
              {threadRows.map((item) => {
                if (item.kind === "toggle") {
                  // The run is identified by its FIRST entry's id, which is also
                  // the key of that entry's own row once the run is open. Two
                  // children with the same key let React lose their identity
                  // across updates, so this key is prefixed.
                  return (
                    <li key={"run-" + item.id} className="flex justify-center">
                      <button
                        type="button"
                        aria-expanded={item.open}
                        onClick={() =>
                          setOpenRuns((current) => {
                            const next = new Set(current);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                        className="focus-ring rounded-full border border-edge-soft bg-surface px-3 py-1.5 text-2xs text-ink-muted transition-colors hover:bg-surface-sunken"
                      >
                        {t("assistant.threadCollapsed", locale).replace("{count}", String(item.count))}
                        {" · "}
                        <span className="font-medium text-ink">
                          {item.open
                            ? t("assistant.threadCollapsedHide", locale)
                            : t("assistant.threadCollapsedShow", locale)}
                        </span>
                      </button>
                    </li>
                  );
                }
                const entry = item.entry;
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
      {pausedNotice && !error ? <Flash tone="info" message={pausedNotice} /> : null}

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
            <Button variant="secondary" disabled={isBusy && !readingBack} onClick={() => void confirmProposal("reject")}>{t("assistant.doNotSave", locale)}</Button>
            <Button loading={phase === "committing"} disabled={isBusy && phase !== "committing" && !readingBack} onClick={() => void confirmProposal("confirm")}>{t("assistant.confirmSave", locale)}</Button>
          </div>
        </Card>
      ) : null}

      {turn?.kind === "needs_consent" && !noticeNeeded && farmAiEnabled ? (
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

      {/* Starters, shown only while there is nothing to read yet, the same
          reason a chat app hides its suggestions after the first message. They
          fill the typing box, which hands-free hides, so they step aside too. */}
      {!turn && !transcript && !completion && visibleThread.length === 0 && !voiceMode ? (
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

      {/* == Composer =======================================================
          One composer at the foot of the column, in three tiers of weight: the two
          ways to TALK first, side by side at the same size (speaking is the everyday
          way, hands-free the eyes-up one, and a farmer chooses between them, so
          neither hides behind the other); typing beneath them, quieter, one line with
          its send inside the box. The explanations that used to crowd this card live
          in the "Voice and AI help" section under it.

          Every control here is at least 48px on a phone: this is for someone in a cab
          wearing gloves. Not sticky: pinned to the viewport it sat on top of the
          thread and hid exactly the newest exchanges. */}
      <Card className="shadow-soft">
        {voiceMode ? (
          /* == Hands-free =====================================================
             Replaces the composer while it runs: one large status mark, what was
             heard, and the controls a gloved thumb needs. The confirmation card
             above it is untouched, and its tap is still the only way to save. */
          <div className="flex flex-col items-center gap-4 text-center">
            <div aria-live="polite" aria-atomic="true" className="flex flex-col items-center gap-3">
              <span
                aria-hidden
                className={cn(
                  "flex h-20 w-20 items-center justify-center rounded-full text-3xl transition-colors",
                  phase === "listening"
                    ? "animate-pulse bg-status-overdue text-white ring-8 ring-status-overdue/15"
                    : phase === "speaking"
                      ? "bg-brand-600 text-white ring-8 ring-brand-600/15"
                      : "bg-surface-sunken text-ink-muted",
                )}
              >
                {phase === "speaking" ? <HeadsetIcon /> : <MicIcon />}
              </span>
              <p className="text-lg font-semibold text-ink">
                {voicePhaseLabel(phase, turn?.kind === "confirm", locale)}
              </p>
            </div>
            {transcript ? (
              <p className="w-full whitespace-pre-wrap rounded-xl bg-surface-sunken/60 px-4 py-3 text-left text-base leading-7 text-ink">
                <span className="sr-only">{t("assistant.voice.heard", locale)}: </span>
                {transcript}
              </p>
            ) : null}
            <div className="flex w-full flex-col-reverse gap-2 sm:flex-row [&>*]:sm:flex-1">
              <Button size="lg" variant="secondary" onClick={() => void stopVoiceMode()}>
                <StopIcon aria-hidden />
                {t("assistant.voice.stop", locale)}
              </Button>
              {phase === "listening" && transcript ? (
                <Button size="lg" onClick={sendVoiceNow}>
                  {t("assistant.voice.sendNow", locale)}
                </Button>
              ) : null}
              {phase === "speaking" ? (
                <Button size="lg" onClick={interruptVoice}>
                  <MicIcon aria-hidden />
                  {t("assistant.voice.interrupt", locale)}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <div
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
            >
              <span className="text-sm font-semibold text-ink">{phaseLabel(phase, locale)}</span>
              {!online ? <span className="text-xs text-ink-muted">{t("assistant.offlinePrivacy", locale)}</span> : null}
              {voiceNotice ? <span className="basis-full text-sm text-ink">{voiceNotice}</span> : null}
            </div>

            {/* What was heard, editable before it is acted on. This is the product's
                real safeguard and it stays exactly where the sending happens. */}
            {transcript ? (
              <div className="mb-4 border-b border-edge-soft pb-4">
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

            {/* The two ways to talk. */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                aria-pressed={isListening}
                disabled={isBusy}
                onClick={() => void (isListening ? stopListening() : startListening())}
                className={cn(
                  "focus-ring flex min-h-[64px] items-center justify-center gap-2.5 rounded-2xl px-3 text-base font-semibold text-white shadow-xs transition-colors",
                  isListening
                    ? "animate-pulse bg-status-overdue hover:bg-danger-600"
                    : "bg-brand-600 hover:bg-brand-700 active:bg-brand-800",
                  isBusy && "cursor-not-allowed opacity-50",
                )}
              >
                <span aria-hidden className="text-2xl">{isListening ? <StopIcon /> : <MicIcon />}</span>
                <span>{isListening ? t("assistant.tapToStop", locale) : t("assistant.tapToSpeak", locale)}</span>
              </button>
              <button
                type="button"
                disabled={!online || isBusy || isListening}
                onClick={startVoiceMode}
                className="focus-ring flex min-h-[64px] items-center justify-center gap-2.5 rounded-2xl border border-sand-300 bg-surface px-3 text-base font-semibold text-sand-800 shadow-xs transition-colors hover:bg-sand-50 active:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span aria-hidden className="text-2xl text-brand-ink"><HeadsetIcon /></span>
                {/* "Talk hands-free" wrapped onto two lines at half a phone's width. */}
                <span className="sm:hidden">{t("assistant.voice.startShort", locale)}</span>
                <span className="hidden sm:inline">{t("assistant.voice.start", locale)}</span>
              </button>
            </div>
            <p className="mt-2 text-center text-xs leading-5 text-ink-muted">{t("assistant.voice.startHint", locale)}</p>

            {/* Typing: one line that grows, Enter to send, the send button inside the box. */}
            <div className="relative mt-4">
              <label htmlFor="assistant-typed" className="sr-only">
                {t("assistant.typeLabel", locale)}
              </label>
              <Textarea
                id="assistant-typed"
                rows={1}
                className="min-h-[56px] resize-none rounded-2xl py-3.5 pl-4 pr-16 leading-6"
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
                aria-label={t("assistant.sendTranscript", locale)}
                disabled={!typedInput.trim() || (phase !== "idle" && phase !== "error")}
                onClick={() => void submitTyped()}
                className={cn(
                  "focus-ring absolute bottom-1 right-1 flex h-12 w-12 items-center justify-center rounded-xl text-xl transition-colors",
                  typedInput.trim() && (phase === "idle" || phase === "error")
                    ? "bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800"
                    : "bg-surface-sunken text-ink-subtle",
                  "disabled:cursor-not-allowed",
                )}
              >
                <SendIcon />
              </button>
            </div>
          </>
        )}
      </Card>

      {/* == The small print ================================================
          Always present, never folded into the starters: the ordinary screens are the
          fallback when the assistant cannot help, and AI permission has to stay one tap
          away once a conversation has begun, which is when somebody might withdraw it.
          The privacy wording is the same as before, now under one heading instead of
          spread through the composer. The notice that must come FIRST (POPIA s18) is
          the card at the top of the page, not this. */}
      <div className="flex flex-col gap-3">
        <p className="px-1 text-xs leading-5 text-ink-muted">
          {t("assistant.manualFallback", locale)}{" "}
          <Link href="/faults" className="font-semibold text-brand-ink underline">
            {t("nav.faults", locale)}
          </Link>{" "}
          ·{" "}
          <Link href="/machines" className="font-semibold text-brand-ink underline">
            {t("nav.machines", locale)}
          </Link>
        </p>
        <Disclosure
          summary={t("assistant.aboutTitle", locale)}
          meta={
            !farmAiEnabled
              ? t("assistant.aiStatusFarmOff", locale)
              : aiConsent
                ? t("assistant.aiStatusOn", locale)
                : t("assistant.aiStatusOff", locale)
          }
        >
          <div className="space-y-3 px-4 pb-4 text-sm leading-6 text-ink-muted sm:px-5 sm:pb-5">
            <p>{!online ? t("assistant.offlinePrivacy", locale) : aiHelpActive ? t("assistant.audioPrivacyAi", locale) : t("assistant.audioPrivacy", locale)}</p>
            {infoButton ? null : <p>{t("assistant.typeHint", locale)}</p>}
            {!farmAiEnabled ? (
              // The owner switched AI off for the farm: nothing for this person to switch.
              <p>{t("assistant.aiHelpFarmOff", locale)}</p>
            ) : aiConsent ? (
              <div className="flex flex-col items-start gap-2">
                <p>{t("assistant.audioConsentActive", locale)}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={consentUpdating}
                  disabled={isBusy && !consentUpdating}
                  onClick={() => void updateAiConsent(false)}
                >
                  {t("assistant.consentWithdraw", locale)}
                </Button>
              </div>
            ) : noticeSeen ? (
              // Switched off: switching back on stays one calm tap away, never a nag.
              <div className="flex flex-col items-start gap-2">
                <p>{t("assistant.aiHelpOffBody", locale)}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={consentUpdating}
                  disabled={isBusy && !consentUpdating}
                  onClick={() => void updateAiConsent(true)}
                >
                  {t("assistant.consentAllow", locale)}
                </Button>
              </div>
            ) : null}
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
