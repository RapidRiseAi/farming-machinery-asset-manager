"use client";

type SpeechSdk = typeof import("microsoft-cognitiveservices-speech-sdk");
type AudioConfig = import("microsoft-cognitiveservices-speech-sdk").AudioConfig;
type SpeechConfig = import("microsoft-cognitiveservices-speech-sdk").SpeechConfig;
type SpeechRecognizer =
  import("microsoft-cognitiveservices-speech-sdk").SpeechRecognizer;
type SpeechSynthesizer =
  import("microsoft-cognitiveservices-speech-sdk").SpeechSynthesizer;
type SpeakerAudioDestination =
  import("microsoft-cognitiveservices-speech-sdk").SpeakerAudioDestination;

const TOKEN_ENDPOINT = "/api/assistant/speech-token";
const TOKEN_REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_BUFFER_MS = 30_000;
const TOKEN_MAX_REUSE_MS = 8.5 * 60_000;
const SDK_START_TIMEOUT_MS = 60_000;
const SDK_STOP_TIMEOUT_MS = 5_000;
const SDK_CLOSE_TIMEOUT_MS = 2_000;
const FILE_RECOGNITION_START_TIMEOUT_MS = 15_000;
// A 60-second recording needs a little wall-clock headroom for upload and finalization.
const FILE_RECOGNITION_TIMEOUT_MS = 75_000;
const SYNTHESIS_TIMEOUT_MS = 120_000;
const MAX_PHRASES = 500;
const MAX_PHRASE_LENGTH = 120;
const MAX_SPEECH_TEXT_LENGTH = 8_000;

export type SpeechLocale = "af-ZA" | "en-ZA";
export type SpeechVoice = "willem" | "ollie";
export type SpeechRecognitionState =
  | "starting"
  | "listening"
  | "stopping"
  | "stopped";

export type SpeechClientErrorCode =
  | "unsupported_browser"
  | "microphone_denied"
  | "microphone_unavailable"
  | "not_authorized"
  | "authentication_failed"
  | "invalid_configuration"
  | "invalid_input"
  | "busy"
  | "rate_limited"
  | "quota_exceeded"
  | "network"
  | "timeout"
  | "service_unavailable"
  | "token_unavailable"
  | "cancelled"
  | "unknown";

const ERROR_INFO = {
  unsupported_browser: {
    message: "Speech is not supported by this browser.",
    retryable: false,
  },
  microphone_denied: {
    message: "Microphone access is blocked. Allow access or type your request.",
    retryable: true,
  },
  microphone_unavailable: {
    message: "No usable microphone is available.",
    retryable: true,
  },
  not_authorized: {
    message: "You do not have access to the voice assistant.",
    retryable: false,
  },
  authentication_failed: {
    message: "The speech session expired. Please try again.",
    retryable: true,
  },
  invalid_configuration: {
    message: "The speech service is not configured correctly.",
    retryable: false,
  },
  invalid_input: {
    message: "There is no valid text to speak.",
    retryable: false,
  },
  busy: {
    message: "The speech assistant is already busy.",
    retryable: true,
  },
  rate_limited: {
    message: "The speech service is busy. Please wait and try again.",
    retryable: true,
  },
  quota_exceeded: {
    message: "The speech allowance has been reached.",
    retryable: false,
  },
  network: {
    message: "Speech could not connect. Check your connection and try again.",
    retryable: true,
  },
  timeout: {
    message: "The speech service took too long to respond.",
    retryable: true,
  },
  service_unavailable: {
    message: "The speech service is temporarily unavailable.",
    retryable: true,
  },
  token_unavailable: {
    message: "A secure speech session could not be started.",
    retryable: true,
  },
  cancelled: {
    message: "The speech operation was cancelled.",
    retryable: true,
  },
  unknown: {
    message: "Speech could not be completed. Please try again.",
    retryable: true,
  },
} satisfies Record<
  SpeechClientErrorCode,
  { message: string; retryable: boolean }
>;

/** A deliberately sanitized error that is safe to display or log by code. */
export class SpeechClientError extends Error {
  readonly code: SpeechClientErrorCode;
  readonly retryable: boolean;

  constructor(code: SpeechClientErrorCode) {
    super(ERROR_INFO[code].message);
    this.name = "SpeechClientError";
    this.code = code;
    this.retryable = ERROR_INFO[code].retryable;
  }
}

export interface SpeechTranscript {
  text: string;
  locale: SpeechLocale;
  isFinal: boolean;
  resultId: string;
  durationMs: number;
  offsetMs: number;
}

export interface SpeechRecognitionOptions {
  locale: SpeechLocale;
  /** Used only for en-ZA. Empty, duplicate, and over-limit entries are discarded. */
  phrases?: readonly string[];
  /** Azure accepts 0-2. Defaults to 1.5. */
  phraseWeight?: number;
  onPartial?: (transcript: SpeechTranscript) => void;
  onFinal?: (transcript: SpeechTranscript) => void;
  onNoMatch?: () => void;
  onError?: (error: SpeechClientError) => void;
  onStateChange?: (state: SpeechRecognitionState) => void;
}

export interface SpeechSynthesisOptions {
  voice: SpeechVoice;
}

/** Create once in a React ref, then dispose it from the component cleanup function. */
export interface SpeechClient {
  startRecognition(options: SpeechRecognitionOptions): Promise<void>;
  stopRecognition(): Promise<void>;
  /** Transcribe a local WAV capture of up to 60 seconds after reconnecting. */
  recognizeFile(file: File, options: SpeechRecognitionOptions): Promise<string>;
  speak(text: string, options: SpeechSynthesisOptions): Promise<void>;
  stopSpeaking(): Promise<void>;
  dispose(): Promise<void>;
}

interface SpeechToken {
  token: string;
  region: string;
  refreshAt: number;
}

interface RecognitionOperation {
  recognizer: SpeechRecognizer;
  audioConfig: AudioConfig;
  speechConfig: SpeechConfig;
  options: SpeechRecognitionOptions;
  state: SpeechRecognitionState;
  started: boolean;
  closed: boolean;
  errorReported: boolean;
  source: "microphone" | "file";
  fileSettlement?: {
    settle: (error?: SpeechClientError) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  };
  stopPromise?: Promise<void>;
}

interface SynthesisOperation {
  synthesizer: SpeechSynthesizer;
  audioConfig: AudioConfig;
  speechConfig: SpeechConfig;
  player: SpeakerAudioDestination;
  resolve: () => void;
  reject: (error: SpeechClientError) => void;
  settled: boolean;
  serviceCompleted: boolean;
  playbackCompleted: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
  audioElement?: HTMLAudioElement;
  audioErrorHandler?: () => void;
}

interface CallbackClosable {
  close(success?: () => void, error?: (error: string) => void): void;
}

const VOICES = {
  willem: {
    locale: "af-ZA",
    name: "af-ZA-WillemNeural",
  },
  ollie: {
    locale: "en-GB",
    name: "en-GB-OllieMultilingualNeural",
  },
} as const satisfies Record<SpeechVoice, { locale: string; name: string }>;

let speechSdkPromise: Promise<SpeechSdk> | undefined;

async function loadSpeechSdk(): Promise<SpeechSdk> {
  if (typeof window === "undefined") {
    throw new SpeechClientError("unsupported_browser");
  }

  if (!speechSdkPromise) {
    speechSdkPromise = import("microsoft-cognitiveservices-speech-sdk")
      .then((sdk) => {
        // This is global and must happen before any recognizer is constructed.
        sdk.Recognizer.enableTelemetry(false);
        return sdk;
      })
      .catch(() => {
        speechSdkPromise = undefined;
        throw new SpeechClientError("service_unavailable");
      });
  }

  return speechSdkPromise;
}

function safeInvoke<TArgs extends readonly unknown[]>(
  callback: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  try {
    callback?.(...args);
  } catch {
    // Consumer callbacks must not interrupt SDK cleanup or event processing.
  }
}

function closeSync(resource: { close(): void } | undefined): void {
  try {
    resource?.close();
  } catch {
    // Best-effort disposal; never expose SDK internals to the UI.
  }
}

function closeAsync(resource: CallbackClosable | undefined): Promise<void> {
  if (!resource) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, SDK_CLOSE_TIMEOUT_MS);

    try {
      resource.close(finish, finish);
    } catch {
      finish();
    }
  });
}

function runSdkOperation(
  start: (success: () => void, error: (error: string) => void) => void,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: SpeechClientError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new SpeechClientError("timeout")),
      timeoutMs,
    );

    try {
      start(
        () => finish(),
        (error) => finish(sanitizeUnknownError(error)),
      );
    } catch (error) {
      finish(sanitizeUnknownError(error));
    }
  });
}

function sanitizeUnknownError(error: unknown): SpeechClientError {
  if (error instanceof SpeechClientError) return error;

  const name = error instanceof DOMException ? error.name.toLowerCase() : "";
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : "";
  const value = `${name} ${raw}`.toLowerCase();

  if (
    value.includes("notallowed") ||
    value.includes("permission") ||
    value.includes("securityerror")
  ) {
    return new SpeechClientError("microphone_denied");
  }
  if (
    value.includes("notfound") ||
    value.includes("devicesnotfound") ||
    value.includes("notreadable") ||
    value.includes("trackstarterror")
  ) {
    return new SpeechClientError("microphone_unavailable");
  }
  if (value.includes("abort")) {
    return new SpeechClientError("cancelled");
  }
  if (value.includes("401") || value.includes("authentication")) {
    return new SpeechClientError("authentication_failed");
  }
  if (value.includes("429") || value.includes("too many")) {
    return new SpeechClientError("rate_limited");
  }
  if (value.includes("timeout") || value.includes("timed out")) {
    return new SpeechClientError("timeout");
  }
  if (
    value.includes("network") ||
    value.includes("connection") ||
    value.includes("websocket")
  ) {
    return new SpeechClientError("network");
  }

  return new SpeechClientError("unknown");
}

function cancellationError(
  sdk: SpeechSdk,
  code: import("microsoft-cognitiveservices-speech-sdk").CancellationErrorCode,
): SpeechClientError {
  switch (code) {
    case sdk.CancellationErrorCode.AuthenticationFailure:
      return new SpeechClientError("authentication_failed");
    case sdk.CancellationErrorCode.BadRequestParameters:
      return new SpeechClientError("invalid_configuration");
    case sdk.CancellationErrorCode.TooManyRequests:
      return new SpeechClientError("rate_limited");
    case sdk.CancellationErrorCode.ConnectionFailure:
      return new SpeechClientError("network");
    case sdk.CancellationErrorCode.ServiceTimeout:
      return new SpeechClientError("timeout");
    case sdk.CancellationErrorCode.ServiceError:
      return new SpeechClientError("service_unavailable");
    case sdk.CancellationErrorCode.Forbidden:
      return new SpeechClientError("quota_exceeded");
    case sdk.CancellationErrorCode.RuntimeError:
      return new SpeechClientError("unknown");
    case sdk.CancellationErrorCode.NoError:
    default:
      return new SpeechClientError("cancelled");
  }
}

function tokenResponseError(status: number): SpeechClientError {
  if (status === 401 || status === 403) {
    return new SpeechClientError("not_authorized");
  }
  if (status === 429) {
    return new SpeechClientError("rate_limited");
  }
  if (status >= 500) {
    return new SpeechClientError("service_unavailable");
  }
  return new SpeechClientError("token_unavailable");
}

function sanitizePhrases(phrases: readonly string[] | undefined): string[] {
  if (!phrases?.length) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const phrase of phrases) {
    const cleaned = phrase.trim().replace(/\s+/g, " ");
    if (!cleaned || cleaned.length > MAX_PHRASE_LENGTH) continue;

    const key = cleaned.toLocaleLowerCase("en-ZA");
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(cleaned);
    if (result.length === MAX_PHRASES) break;
  }

  return result;
}

function phraseWeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1.5;
  return Math.min(2, Math.max(0, value));
}

function toTranscript(
  text: string,
  locale: SpeechLocale,
  result: {
    resultId: string;
    duration: number;
    offset: number;
  },
  isFinal: boolean,
): SpeechTranscript {
  return {
    text,
    locale,
    isFinal,
    resultId: result.resultId,
    durationMs: Math.max(0, result.duration / 10_000),
    offsetMs: Math.max(0, result.offset / 10_000),
  };
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function speechOnlyText(text: string, voice: SpeechVoice): string {
  if (voice !== "willem") return text;
  return text.replace(/\bJohn\s+Deere\b/giu, "Djon Deer");
}

class AzureBrowserSpeechClient implements SpeechClient {
  private disposed = false;
  private cachedToken: SpeechToken | undefined;
  private tokenRequest: Promise<SpeechToken> | undefined;
  private tokenAbort: AbortController | undefined;
  private recognitionStart: Promise<void> | undefined;
  private recognitionOperation: RecognitionOperation | undefined;
  private recognitionStopRequested = false;
  private pendingFileRecognition:
    | {
        promise: Promise<never>;
        cancel: (error: SpeechClientError) => void;
      }
    | undefined;
  private synthesisOperation: SynthesisOperation | undefined;
  private synthesisGeneration = 0;

  async startRecognition(options: SpeechRecognitionOptions): Promise<void> {
    this.assertActive();
    if (options.locale !== "af-ZA" && options.locale !== "en-ZA") {
      throw new SpeechClientError("invalid_configuration");
    }
    if (this.recognitionStart || this.recognitionOperation) {
      throw new SpeechClientError("busy");
    }

    this.recognitionStopRequested = false;
    const start = Promise.resolve().then(() =>
      this.startRecognitionInternal(options),
    );
    this.recognitionStart = start;

    try {
      await start;
    } finally {
      if (this.recognitionStart === start) this.recognitionStart = undefined;
    }
  }

  async stopRecognition(): Promise<void> {
    this.recognitionStopRequested = true;
    this.pendingFileRecognition?.cancel(new SpeechClientError("cancelled"));

    const starting = this.recognitionStart;
    if (starting) {
      try {
        await starting;
      } catch {
        // The start path reports its own sanitized error and closes partial resources.
      }
    }

    const operation = this.recognitionOperation;
    if (operation) await this.stopRecognitionOperation(operation);
  }

  async recognizeFile(file: File, options: SpeechRecognitionOptions): Promise<string> {
    this.assertActive();
    if (!(file instanceof File) || file.size === 0 || file.size > 25 * 1024 * 1024) {
      throw new SpeechClientError("invalid_input");
    }
    if (options.locale !== "af-ZA" && options.locale !== "en-ZA") {
      throw new SpeechClientError("invalid_configuration");
    }
    if (
      this.recognitionStart ||
      this.recognitionOperation ||
      this.pendingFileRecognition
    ) {
      throw new SpeechClientError("busy");
    }

    this.recognitionStopRequested = false;
    let cancelPending!: (error: SpeechClientError) => void;
    let pendingSettled = false;
    const pendingPromise = new Promise<never>((_resolve, reject) => {
      cancelPending = (error) => {
        if (pendingSettled) return;
        pendingSettled = true;
        reject(error);
      };
    });
    const pending = { promise: pendingPromise, cancel: cancelPending };
    this.pendingFileRecognition = pending;

    let sdk: SpeechSdk;
    let token: SpeechToken;
    try {
      safeInvoke(options.onStateChange, "starting");
      await Promise.race([this.stopSpeaking(), pendingPromise]);
      if (this.recognitionStopRequested) throw new SpeechClientError("cancelled");

      [sdk, token] = await Promise.race([
        Promise.all([loadSpeechSdk(), this.getSpeechToken()]),
        pendingPromise,
      ]);
      if (this.recognitionStopRequested) throw new SpeechClientError("cancelled");
      this.assertActive();
    } catch (caught) {
      if (this.pendingFileRecognition === pending) {
        this.pendingFileRecognition = undefined;
      }
      const sanitized = sanitizeUnknownError(caught);
      if (sanitized.code !== "cancelled") safeInvoke(options.onError, sanitized);
      safeInvoke(options.onStateChange, "stopped");
      throw sanitized;
    }

    let speechConfig: SpeechConfig | undefined;
    let audioConfig: AudioConfig | undefined;
    let recognizer: SpeechRecognizer | undefined;
    let operation: RecognitionOperation | undefined;
    try {
      speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token.token, token.region);
      speechConfig.speechRecognitionLanguage = options.locale;
      audioConfig = sdk.AudioConfig.fromWavFileInput(file);
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      operation = {
        recognizer,
        audioConfig,
        speechConfig,
        options,
        state: "starting",
        started: false,
        closed: false,
        errorReported: false,
        source: "file",
      };
      this.recognitionOperation = operation;
      const fileOperation = operation;
      const fileRecognizer = recognizer;

      if (options.locale === "en-ZA") {
        const phrases = sanitizePhrases(options.phrases);
        if (phrases.length) {
          const grammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
          grammar.addPhrases(phrases);
          grammar.setWeight(phraseWeight(options.phraseWeight));
        }
      }

      const segments: string[] = [];
      const finalResultIds = new Set<string>();
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let settleResult: (error?: SpeechClientError) => void = () => undefined;

      const resultPromise = new Promise<string>((resolve, reject) => {
        settleResult = (error) => {
          if (settled) return;
          settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }

          if (error) {
            reject(error);
            return;
          }

          const text = segments.join(" ").replace(/\s+/g, " ").trim();
          if (!text) {
            safeInvoke(options.onNoMatch);
            reject(new SpeechClientError("unknown"));
            return;
          }
          resolve(text);
        };
      });

      fileOperation.fileSettlement = { settle: settleResult };
      timeoutId = setTimeout(() => {
        const error = new SpeechClientError("timeout");
        settleResult(error);
        void this.stopRecognitionOperation(fileOperation, error);
      }, FILE_RECOGNITION_TIMEOUT_MS);
      fileOperation.fileSettlement.timeoutId = timeoutId;

      fileRecognizer.recognizing = (_sender, event) => {
        const text = event.result.text.trim();
        if (!text || fileOperation.closed) return;
        safeInvoke(
          options.onPartial,
          toTranscript(text, options.locale, event.result, false),
        );
      };

      fileRecognizer.recognized = (_sender, event) => {
        if (
          fileOperation.closed ||
          event.result.reason !== sdk.ResultReason.RecognizedSpeech
        ) {
          return;
        }

        const text = event.result.text.trim();
        const resultId = event.result.resultId;
        if (!text || (resultId && finalResultIds.has(resultId))) return;
        if (resultId) finalResultIds.add(resultId);
        segments.push(text);
        safeInvoke(
          options.onFinal,
          toTranscript(text, options.locale, event.result, true),
        );
      };

      fileRecognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.EndOfStream) {
          settleResult();
          return;
        }

        const error = cancellationError(sdk, event.errorCode);
        if (error.code === "authentication_failed") this.cachedToken = undefined;
        settleResult(error);
        void this.stopRecognitionOperation(fileOperation, error);
      };

      fileRecognizer.sessionStopped = () => settleResult();

      const startPromise = runSdkOperation(
        (success, error) =>
          fileRecognizer.startContinuousRecognitionAsync(success, error),
        FILE_RECOGNITION_START_TIMEOUT_MS,
      ).then(
        () => {
          if (fileOperation.closed) return;
          fileOperation.started = true;
          this.setRecognitionState(fileOperation, "listening");
        },
        (error) => settleResult(error),
      );

      // Stop/dispose can settle the result while the SDK's start callback is still pending.
      await Promise.race([
        startPromise,
        resultPromise.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      return await resultPromise;
    } catch (caught) {
      const sanitized = sanitizeUnknownError(caught);
      if (operation && sanitized.code !== "cancelled") this.reportRecognitionError(operation, sanitized);
      if (sanitized.code === "authentication_failed") this.cachedToken = undefined;
      throw sanitized;
    } finally {
      if (this.pendingFileRecognition === pending) {
        this.pendingFileRecognition = undefined;
      }
      if (operation) {
        await this.closeRecognitionOperation(operation);
        this.setRecognitionState(operation, "stopped");
      } else {
        await closeAsync(recognizer);
        closeSync(audioConfig);
        closeSync(speechConfig);
        safeInvoke(options.onStateChange, "stopped");
      }
    }
  }

  async speak(text: string, options: SpeechSynthesisOptions): Promise<void> {
    this.assertActive();
    if (options.voice !== "willem" && options.voice !== "ollie") {
      throw new SpeechClientError("invalid_configuration");
    }

    const cleanedText = text.trim();
    if (!cleanedText || cleanedText.length > MAX_SPEECH_TEXT_LENGTH) {
      throw new SpeechClientError("invalid_input");
    }

    const generation = ++this.synthesisGeneration;
    await this.stopRecognition();
    await this.stopActiveSynthesis(new SpeechClientError("cancelled"));

    const [sdk, token] = await Promise.all([
      loadSpeechSdk(),
      this.getSpeechToken(),
    ]);
    if (this.disposed || generation !== this.synthesisGeneration) {
      throw new SpeechClientError("cancelled");
    }

    const voice = VOICES[options.voice];
    let speechConfig: SpeechConfig | undefined;
    let audioConfig: AudioConfig | undefined;
    let synthesizer: SpeechSynthesizer | undefined;
    let player: SpeakerAudioDestination | undefined;

    try {
      speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
        token.token,
        token.region,
      );
      speechConfig.speechSynthesisLanguage = voice.locale;
      speechConfig.speechSynthesisVoiceName = voice.name;
      speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

      player = new sdk.SpeakerAudioDestination();
      audioConfig = sdk.AudioConfig.fromSpeakerOutput(player);
      synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
    } catch (error) {
      await closeAsync(synthesizer);
      if (audioConfig) closeSync(audioConfig);
      else closeSync(player);
      closeSync(speechConfig);
      throw sanitizeUnknownError(error);
    }

    if (!speechConfig || !audioConfig || !synthesizer || !player) {
      if (audioConfig) closeSync(audioConfig);
      else closeSync(player);
      closeSync(speechConfig);
      throw new SpeechClientError("unknown");
    }

    return new Promise<void>((resolve, reject) => {
      const operation: SynthesisOperation = {
        synthesizer,
        audioConfig,
        speechConfig,
        player,
        resolve,
        reject,
        settled: false,
        serviceCompleted: false,
        playbackCompleted: false,
      };
      this.synthesisOperation = operation;

      player.onAudioStart = () => {
        if (operation.settled) {
          try {
            player.pause();
          } catch {
            // The synthesizer close path remains the authoritative fallback.
          }
          return;
        }
        try {
          const audioElement = player.internalAudio;
          if (!operation.audioErrorHandler) {
            const audioErrorHandler = () => {
              void this.finishSynthesis(
                operation,
                new SpeechClientError("service_unavailable"),
              );
            };
            operation.audioElement = audioElement;
            operation.audioErrorHandler = audioErrorHandler;
            audioElement.addEventListener("error", audioErrorHandler, {
              once: true,
            });
          }

          // SpeakerAudioDestination does not expose its internal play() rejection.
          // Calling it here mirrors the SDK call and lets us report autoplay blocks.
          const playback = audioElement.play();
          void playback.catch(() => {
            void this.finishSynthesis(
              operation,
              new SpeechClientError("service_unavailable"),
            );
          });
        } catch {
          void this.finishSynthesis(
            operation,
            new SpeechClientError("service_unavailable"),
          );
        }
      };

      player.onAudioEnd = () => {
        operation.playbackCompleted = true;
        this.finishSynthesisIfComplete(operation);
      };

      operation.timeoutId = setTimeout(() => {
        void this.finishSynthesis(operation, new SpeechClientError("timeout"));
      }, SYNTHESIS_TIMEOUT_MS);

      try {
        synthesizer.speakTextAsync(
          speechOnlyText(cleanedText, options.voice),
          (result) => {
            if (
              result.reason ===
              sdk.ResultReason.SynthesizingAudioCompleted
            ) {
              operation.serviceCompleted = true;
              this.finishSynthesisIfComplete(operation);
              return;
            }

            const details = sdk.CancellationDetails.fromResult(result);
            const error = cancellationError(sdk, details.ErrorCode);
            if (error.code === "authentication_failed") {
              this.cachedToken = undefined;
            }
            void this.finishSynthesis(operation, error);
          },
          (error) => {
            const sanitized = sanitizeUnknownError(error);
            if (sanitized.code === "authentication_failed") {
              this.cachedToken = undefined;
            }
            void this.finishSynthesis(operation, sanitized);
          },
        );
      } catch (error) {
        void this.finishSynthesis(operation, sanitizeUnknownError(error));
      }
    });
  }

  async stopSpeaking(): Promise<void> {
    this.synthesisGeneration += 1;
    await this.stopActiveSynthesis(new SpeechClientError("cancelled"));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;

    this.disposed = true;
    this.synthesisGeneration += 1;
    this.tokenAbort?.abort();

    await Promise.allSettled([
      this.stopRecognition(),
      this.stopActiveSynthesis(new SpeechClientError("cancelled")),
    ]);

    this.cachedToken = undefined;
    this.tokenRequest = undefined;
    this.tokenAbort = undefined;
  }

  private async startRecognitionInternal(
    options: SpeechRecognitionOptions,
  ): Promise<void> {
    safeInvoke(options.onStateChange, "starting");
    let speechConfig: SpeechConfig | undefined;
    let audioConfig: AudioConfig | undefined;
    let recognizer: SpeechRecognizer | undefined;
    let operation: RecognitionOperation | undefined;

    try {
      await this.stopSpeaking();

      if (this.recognitionStopRequested) {
        safeInvoke(options.onStateChange, "stopping");
        safeInvoke(options.onStateChange, "stopped");
        return;
      }
      this.assertActive();

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new SpeechClientError("microphone_unavailable");
      }

      const [sdk, token] = await Promise.all([
        loadSpeechSdk(),
        this.getSpeechToken(),
      ]);
      if (this.recognitionStopRequested) {
        safeInvoke(options.onStateChange, "stopping");
        safeInvoke(options.onStateChange, "stopped");
        return;
      }
      this.assertActive();

      speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
        token.token,
        token.region,
      );
      speechConfig.speechRecognitionLanguage = options.locale;

      audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      operation = {
        recognizer,
        audioConfig,
        speechConfig,
        options,
        state: "starting",
        started: false,
        closed: false,
        errorReported: false,
        source: "microphone",
      };
      this.recognitionOperation = operation;

      if (options.locale === "en-ZA") {
        const phrases = sanitizePhrases(options.phrases);
        if (phrases.length) {
          const grammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
          grammar.addPhrases(phrases);
          grammar.setWeight(phraseWeight(options.phraseWeight));
        }
      }

      recognizer.recognizing = (_sender, event) => {
        const text = event.result.text.trim();
        if (!text) return;
        safeInvoke(
          options.onPartial,
          toTranscript(text, options.locale, event.result, false),
        );
      };

      recognizer.recognized = (_sender, event) => {
        if (event.result.reason === sdk.ResultReason.RecognizedSpeech) {
          const text = event.result.text.trim();
          if (text) {
            safeInvoke(
              options.onFinal,
              toTranscript(text, options.locale, event.result, true),
            );
          }
          return;
        }

        if (event.result.reason === sdk.ResultReason.NoMatch) {
          safeInvoke(options.onNoMatch);
        }
      };

      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.Error) {
          const error = cancellationError(sdk, event.errorCode);
          if (error.code === "authentication_failed") {
            this.cachedToken = undefined;
          }
          this.reportRecognitionError(operation!, error);
        }
        void this.stopRecognitionOperation(operation!);
      };

      recognizer.sessionStopped = () => {
        void this.stopRecognitionOperation(operation!);
      };

      await runSdkOperation(
        (success, error) =>
          recognizer!.startContinuousRecognitionAsync(success, error),
        SDK_START_TIMEOUT_MS,
      );
      operation.started = true;

      // A cancellation event can close the recognizer before the start callback wins.
      if (operation.closed) return;

      if (this.recognitionStopRequested) {
        await this.stopRecognitionOperation(operation);
      } else {
        this.setRecognitionState(operation, "listening");
      }
    } catch (error) {
      const sanitized = sanitizeUnknownError(error);
      if (sanitized.code === "authentication_failed") {
        this.cachedToken = undefined;
      }

      if (operation) {
        if (sanitized.code !== "cancelled") {
          this.reportRecognitionError(operation, sanitized);
        }
        await this.closeRecognitionOperation(operation);
        this.setRecognitionState(operation, "stopped");
      } else {
        await closeAsync(recognizer);
        closeSync(audioConfig);
        closeSync(speechConfig);
        if (sanitized.code !== "cancelled") {
          safeInvoke(options.onError, sanitized);
        }
        safeInvoke(options.onStateChange, "stopped");
      }
      throw sanitized;
    }
  }

  private stopRecognitionOperation(
    operation: RecognitionOperation,
    fileError = new SpeechClientError("cancelled"),
  ): Promise<void> {
    if (operation.source === "file") {
      operation.fileSettlement?.settle(fileError);
    }
    if (operation.stopPromise) return operation.stopPromise;

    let resolveStop!: () => void;
    operation.stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });

    void (async () => {
      this.setRecognitionState(operation, "stopping");

      if (operation.started && !operation.closed) {
        try {
          await runSdkOperation(
            (success, error) =>
              operation.recognizer.stopContinuousRecognitionAsync(
                success,
                error,
              ),
            SDK_STOP_TIMEOUT_MS,
          );
        } catch {
          // Closing below is the authoritative fallback if graceful stop fails.
        }
      }

      await this.closeRecognitionOperation(operation);
      this.setRecognitionState(operation, "stopped");
      resolveStop();
    })();

    return operation.stopPromise;
  }

  private async closeRecognitionOperation(
    operation: RecognitionOperation,
  ): Promise<void> {
    if (operation.closed) return;
    operation.closed = true;

    if (operation.source === "file") {
      operation.fileSettlement?.settle(new SpeechClientError("cancelled"));
      if (operation.fileSettlement?.timeoutId) {
        clearTimeout(operation.fileSettlement.timeoutId);
        operation.fileSettlement.timeoutId = undefined;
      }
    }

    operation.recognizer.recognizing = () => undefined;
    operation.recognizer.recognized = () => undefined;
    operation.recognizer.canceled = () => undefined;
    operation.recognizer.sessionStopped = () => undefined;

    await closeAsync(operation.recognizer);
    closeSync(operation.audioConfig);
    closeSync(operation.speechConfig);

    if (this.recognitionOperation === operation) {
      this.recognitionOperation = undefined;
    }
  }

  private setRecognitionState(
    operation: RecognitionOperation,
    state: SpeechRecognitionState,
  ): void {
    if (operation.state === state) return;
    operation.state = state;
    safeInvoke(operation.options.onStateChange, state);
  }

  private reportRecognitionError(
    operation: RecognitionOperation,
    error: SpeechClientError,
  ): void {
    if (operation.errorReported) return;
    operation.errorReported = true;
    safeInvoke(operation.options.onError, error);
  }

  private async finishSynthesis(
    operation: SynthesisOperation,
    error?: SpeechClientError,
  ): Promise<void> {
    if (operation.settled) return;
    operation.settled = true;

    if (this.synthesisOperation === operation) {
      this.synthesisOperation = undefined;
    }

    if (operation.timeoutId) {
      clearTimeout(operation.timeoutId);
      operation.timeoutId = undefined;
    }
    if (operation.audioElement && operation.audioErrorHandler) {
      operation.audioElement.removeEventListener(
        "error",
        operation.audioErrorHandler,
      );
    }
    operation.player.onAudioStart = () => {
      try {
        operation.player.pause();
      } catch {
        // Ignore late SDK playback callbacks after settlement.
      }
    };
    operation.player.onAudioEnd = () => undefined;

    if (error) {
      try {
        operation.player.pause();
      } catch {
        // Closing the audio config below remains the authoritative fallback.
      }
    }

    await closeAsync(operation.synthesizer);
    closeSync(operation.audioConfig);
    closeSync(operation.speechConfig);

    const audioElement = operation.audioElement ?? operation.player.internalAudio;
    if (audioElement) {
      const source = audioElement.src;
      try {
        audioElement.removeAttribute("src");
        audioElement.load();
      } catch {
        // The SDK resources are already closed; DOM release is best effort.
      }
      if (source.startsWith("blob:")) URL.revokeObjectURL(source);
    }

    if (error) operation.reject(error);
    else operation.resolve();
  }

  private finishSynthesisIfComplete(operation: SynthesisOperation): void {
    if (
      !operation.settled &&
      operation.serviceCompleted &&
      operation.playbackCompleted
    ) {
      void this.finishSynthesis(operation);
    }
  }

  private async stopActiveSynthesis(error: SpeechClientError): Promise<void> {
    const operation = this.synthesisOperation;
    if (operation) await this.finishSynthesis(operation, error);
  }

  private async getSpeechToken(): Promise<SpeechToken> {
    this.assertActive();

    if (this.cachedToken && Date.now() < this.cachedToken.refreshAt) {
      return this.cachedToken;
    }
    if (this.tokenRequest) return this.tokenRequest;

    const request = this.fetchSpeechToken();
    this.tokenRequest = request;

    try {
      const token = await request;
      this.cachedToken = token;
      return token;
    } finally {
      if (this.tokenRequest === request) this.tokenRequest = undefined;
    }
  }

  private async fetchSpeechToken(): Promise<SpeechToken> {
    const controller = new AbortController();
    this.tokenAbort = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TOKEN_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });

      if (!response.ok) throw tokenResponseError(response.status);

      const value: unknown = await response.json();
      if (!isRecord(value)) throw new SpeechClientError("token_unavailable");

      const token = typeof value.token === "string" ? value.token.trim() : "";
      const region =
        typeof value.region === "string"
          ? value.region.trim().toLowerCase()
          : "";
      if (
        token.length < 20 ||
        token.length > 16_384 ||
        !/^[a-z0-9]+$/.test(region)
      ) {
        throw new SpeechClientError("token_unavailable");
      }

      const now = Date.now();
      const serverExpiry = parseExpiry(value.expiresAt);
      if (serverExpiry !== undefined && serverExpiry <= now + 30_000) {
        throw new SpeechClientError("token_unavailable");
      }

      return {
        token,
        region,
        refreshAt: Math.min(
          now + TOKEN_MAX_REUSE_MS,
          serverExpiry === undefined
            ? Number.POSITIVE_INFINITY
            : serverExpiry - TOKEN_REFRESH_BUFFER_MS,
        ),
      };
    } catch (error) {
      if (error instanceof SpeechClientError) throw error;
      if (controller.signal.aborted) {
        throw new SpeechClientError(
          this.disposed ? "cancelled" : timedOut ? "timeout" : "cancelled",
        );
      }
      throw new SpeechClientError("network");
    } finally {
      clearTimeout(timeout);
      if (this.tokenAbort === controller) this.tokenAbort = undefined;
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new SpeechClientError("cancelled");
  }
}

export function createSpeechClient(): SpeechClient {
  return new AzureBrowserSpeechClient();
}
