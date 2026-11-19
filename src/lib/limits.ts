/**
 * The limits catalogue: the ONE place every size, duration, count and window limit lives
 * (BRIEF section 9, founder decisions 8 to 13). Pure, so the browser, the server, the
 * background jobs and the storage-configuration test all read the same numbers.
 * `docs/LIMITS.md` lists each one with where it is used and why it has the value it has.
 *
 * Every entry says what KIND of limit it is, because they mean different things:
 *
 * - `commercial`: what the customer was promised (decision 8 to 11). Changing one changes
 *   the offer; the website and the plan PDF quote these.
 * - `abuse`: an operational protection against runaway or hostile use. Not a promise, and
 *   not a limit a normal customer should meet.
 * - `provider`: imposed by someone else (Vercel, Supabase, Meta, Azure). Quoted from their
 *   current documentation, with the date it was read.
 * - `window`: how much a screen or a query shows or keeps at once. A page size, never a
 *   contractual history limit.
 *
 * Units are explicit. The founder's new media limits are in DECIMAL megabytes (1 MB =
 * 1,000,000 bytes), the same convention as the storage allowance (decision 14). Older
 * caps that were deliberately set in binary units (the fuel-card CSV's 2 MiB, the partner
 * logo bucket) keep them, named as such.
 *
 * A test (limits.test.ts) fails when a raw byte size appears anywhere else under src/.
 */

/** One decimal megabyte, the unit of every customer-facing media limit. */
export const MB = 1_000_000;
/** One binary mebibyte, for the few older caps set in binary units on purpose. */
export const MIB = 1_048_576;
/** One binary kibibyte. */
export const KIB = 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export type LimitKind = "commercial" | "abuse" | "provider" | "window";
export type LimitUnit = "bytes" | "ms" | "rows" | "chars" | "count" | "pixels" | "bps" | "km";

export type LimitEntry = {
  readonly value: number;
  readonly unit: LimitUnit;
  readonly kind: LimitKind;
  /** Shown to customers (help, plan pages, error messages). */
  readonly customer: boolean;
  readonly why: string;
};

const entry = (value: number, unit: LimitUnit, kind: LimitKind, customer: boolean, why: string): LimitEntry =>
  ({ value, unit, kind, customer, why });

/**
 * Every limit by name. Code reads the named constants below; this table is what the
 * docs, the tests and any "what are my limits" screen walk.
 */
export const LIMITS = {
  chatBodyChars: entry(8000, "chars", "abuse", true, "Maximum text per staff chat message; split longer messages."),
  chatRequestBytes: entry(100_000, "bytes", "abuse", true, "Bound streamed chat JSON including multibyte message text and member identifiers."),
  chatMembers: entry(100, "count", "abuse", true, "Maximum active members per group, not a subscription seat limit."),
  chatAttachments: entry(10, "count", "abuse", true, "Maximum files per message; text remains available at full storage."),
  chatPageRows: entry(50, "rows", "window", false, "Chat messages, people and conversations per page; older pages remain available."),
  drivingStops: entry(50, "count", "abuse", true, "Maximum written itinerary stops per driving session, not a plan entitlement."),
  drivingStopsTextChars: entry(10050, "chars", "abuse", false, "Fifty stop names of two hundred characters with line separators."),
  drivingMaxKm: entry(999999999.9, "km", "abuse", false, "Finite nonnegative odometer values with at most one decimal place."),
  // == Pooled attachment storage (decisions 14, 15 and 34; 20261118120000) ==============
  storageMinBytes: entry(2000 * MB, "bytes", "commercial", true,
    "Decision 14: every customer's pool is at least 2 GB (decimal)."),
  storagePerFullSpaceBytes: entry(100 * MB, "bytes", "commercial", true,
    "Decision 14: each purchased full space adds 100 MB to the one shared pool, never a per-asset cap."),
  storagePerEquipmentSpaceBytes: entry(25 * MB, "bytes", "commercial", true,
    "Decision 14: each equipment space, included or extra, adds 25 MB to the pool."),
  storageBlockBytes: entry(10_000 * MB, "bytes", "commercial", true,
    "Decision 15: an optional paid block adds 10 GB (R49 a month, charged monthly)."),
  storageWarnPercent: entry(80, "count", "abuse", true,
    "Engineering default, not a founder term: owners are warned at 80% full."),
  storageUrgentPercent: entry(95, "count", "abuse", true,
    "Engineering default, not a founder term: owners are warned again at 95% full."),

  // == Media an app user attaches (decisions 8 to 12) ==================================
  photoMaxBytes: entry(20 * MB, "bytes", "commercial", true, "Decision 8: photos up to 20 MB."),
  pdfMaxBytes: entry(50 * MB, "bytes", "commercial", true, "Decision 9: PDFs up to 50 MB, kept unchanged."),
  voiceNoteMaxBytes: entry(20 * MB, "bytes", "commercial", true, "Decision 10: recorded voice notes up to 20 MB."),
  voiceNoteMaxMs: entry(10 * MINUTE, "ms", "commercial", true, "Decisions 10 and 11: voice notes up to ten minutes."),
  commandAudioMaxMs: entry(10 * MINUTE, "ms", "commercial", true, "Decision 11: spoken commands up to ten minutes."),
  commandAudioMaxBytes: entry(20 * MB, "bytes", "abuse", false,
    "The byte ceiling for a ten-minute command recording; the recorder bitrate keeps ten minutes far below it."),
  /** Warned this long before a recording stops at its time limit. */
  recordingWarnBeforeMs: entry(30 * SECOND, "ms", "abuse", true, "Warn shortly before a recording stops itself."),
  /** Explicit recorder bitrate: ten minutes is about 3.6 MB of Opus or AAC, well under 20 MB. */
  recorderAudioBitsPerSecond: entry(48_000, "bps", "abuse", false,
    "Set on MediaRecorder so a ten-minute note cannot depend on a browser's adaptive default bitrate."),
  /** Below this a recording is noise, not speech. */
  recordingMinMs: entry(300, "ms", "abuse", false, "Shorter clips carry no words."),

  // == What the server accepts about an image without decoding it ======================
  imageMaxPixels: entry(210_000_000, "pixels", "abuse", false,
    "Decoded-pixel ceiling read from the header: a 200 MP phone photo passes, a decompression bomb does not."),
  imageMaxEdge: entry(30_000, "pixels", "abuse", false, "Longest side an image header may claim."),

  // == Photo reduction in the browser (step 4) =========================================
  photoLongEdge: entry(2560, "pixels", "commercial", true,
    "Ordinary photos are reduced to this long edge: 2560 px keeps a serial plate or a crack legible."),
  photoJpegQualityPercent: entry(85, "count", "abuse", false, "JPEG quality for a reduced photo; 85 keeps fine print."),
  photoJpegQualityMinPercent: entry(80, "count", "abuse", false, "Never re-encode below this quality."),

  // == The direct upload pipeline ======================================================
  /** Supabase: "we recommend using TUS Resumable Upload for uploading files greater than 6MB". */
  resumableThresholdBytes: entry(6 * MB, "bytes", "provider", false,
    "Supabase standard uploads docs (read 2026-11-13): standard upload for files not larger than 6MB, TUS above."),
  /** Supabase: TUS chunkSize "must be set to 6MB (for now)", their example writes 6 * 1024 * 1024. */
  resumableChunkBytes: entry(6 * MIB, "bytes", "provider", false,
    "Supabase resumable uploads docs (read 2026-11-13): chunk size must be 6MB, example 6 * 1024 * 1024."),
  /** Supabase: createSignedUploadUrl "expires 2 hours after creation". */
  signedUploadTtlMs: entry(2 * HOUR, "ms", "provider", false, "Supabase JS reference: a signed upload URL is valid 2 hours."),
  /** An intent lives as long as its signed upload token. */
  uploadIntentTtlMs: entry(2 * HOUR, "ms", "abuse", false, "A reservation is released once its upload can no longer land."),
  /** Supabase dashboard setting the human must raise (docs/LIMITS.md, "Human action"). */
  storageGlobalLimitNeededBytes: entry(50 * MB, "bytes", "provider", false,
    "The project-wide Storage limit must be at least the largest file the app accepts (50 MB PDFs)."),
  /** Bytes the begin step reads back from storage to sniff a file's real type. */
  sniffHeadBytes: entry(256 * KIB, "bytes", "abuse", false,
    "Enough for every header we parse, past a JPEG's 64 kB EXIF block to its frame header."),
  /** Bytes read from the end of a recording to find its duration. */
  sniffTailBytes: entry(512 * KIB, "bytes", "abuse", false, "Enough to find the last Ogg page or WebM cluster."),
  /** Open (not yet finalised) intents one person may hold at once. */
  openIntentsPerUser: entry(40, "count", "abuse", false, "Stops a runaway client from reserving the pool."),

  // == Vercel: bodies that still pass through a function ===============================
  /** Vercel: "The maximum payload size for the request body or the response body of a Vercel Function is 4.5 MB." */
  functionBodyMaxBytes: entry(4_500_000, "bytes", "provider", false,
    "Vercel Functions limits (page dated 2026-08-24): 4.5 MB request or response body."),
  /** What a legacy multipart upload (an installed older app) may still send through a function. */
  legacyMultipartMaxBytes: entry(4_400_000, "bytes", "provider", false,
    "Under Vercel's 4.5 MB with room for the form fields around the file."),
  /** next.config.mjs serverActions.bodySizeLimit, as a string Next understands. */
  serverActionBodyMaxBytes: entry(4_500_000, "bytes", "provider", false,
    "Server actions sit behind the same Vercel 4.5 MB body limit; a larger Next setting promises nothing."),

  // == Assistant: the quick in-request AI hearing of a short clip =====================
  /** 60 s of 16 kHz mono 16-bit WAV is 1.92 MB; longer speech goes through the command-audio job. */
  hearingClipMaxBytes: entry(2_000_000, "bytes", "provider", false,
    "The instant hearing posts WAV through a function (Vercel 4.5 MB); a longer clip uses the upload pipeline."),
  /** Live dictation stops itself here; a longer command keeps going as a recorded command. */
  liveDictationMaxMs: entry(10 * MINUTE, "ms", "commercial", true, "Decision 11: ten-minute spoken commands."),
  /** The instant hearing's clip: one minute of WAV fits hearingClipMaxBytes. */
  instantClipMaxMs: entry(MINUTE, "ms", "provider", false,
    "One minute of 16 kHz WAV is 1.92 MB, the most the instant hearing can post through a function."),
  /** A recorded clip smaller than this holds no speech. */
  clipMinBytes: entry(1000, "bytes", "abuse", false, "A clip under 1 kB is a header and silence."),
  /** A WAV the browser gives Azure to recognise from a file: ten minutes is 19.2 MB. */
  recogniseFileMaxBytes: entry(25 * MIB, "bytes", "abuse", false, "Ten minutes of 16 kHz WAV with headroom."),
  /** What a typed request may hold. */
  assistantTypedMaxChars: entry(2000, "chars", "abuse", false, "A typed request; longer text is a document."),
  /** What a spoken request may hold: ten minutes of speech is roughly 9,000 characters. */
  assistantSpokenMaxChars: entry(16_000, "chars", "abuse", false, "Ten minutes of fast speech with headroom."),
  /** Command audio of a failed or unfinished command is kept this long for "try again". */
  commandAudioRecoveryMs: entry(72 * HOUR, "ms", "abuse", true,
    "Engineering default, not a contractual term: three days to retry a command before its temporary audio is removed."),
  /** A transcription job is tried at most this many times. */
  commandJobMaxAttempts: entry(3, "count", "abuse", false, "Retry limit for one command's transcription."),
  /** A running job not heard from in this long is taken over by the next poll. */
  commandJobLeaseMs: entry(6 * MINUTE, "ms", "abuse", false, "Longer than one Vercel function run (300 s)."),

  // == WhatsApp (provider restrictions, B4) ==============================================
  // Meta's "Supported media types" table (developers.facebook.com/docs/whatsapp/cloud-api/reference/media,
  // read 19 Nov 2026): images JPEG, PNG and static WebP 5 MB; audio (AAC, AMR, MP3, MP4 audio,
  // Ogg with Opus only) 16 MB; documents 100 MB; inbound media at most 100 MB (error 131052).
  // A file past these, or a kind WhatsApp cannot carry here, gets a signed-in app upload link.
  whatsappImageMaxBytes: entry(5 * MB, "bytes", "provider", true, "Meta's WhatsApp image limit: 5 MB (JPEG, PNG, static WebP)."),
  whatsappVoiceMaxBytes: entry(16 * MB, "bytes", "provider", true, "Meta's WhatsApp audio limit: 16 MB."),
  whatsappVoiceMaxMs: entry(10 * MINUTE, "ms", "commercial", true,
    "Decision 11: ten minutes, as in the app; a longer or larger note gets an app upload link instead."),
  whatsappVoiceMinMs: entry(300, "ms", "abuse", false, "Shorter WhatsApp notes carry no words."),

  // == Imports and statements (unchanged) ==============================================
  fuelCardCsvMaxBytes: entry(2 * MIB, "bytes", "abuse", true, "Reviewed 2 MiB fuel-card CSV cap, unchanged (BRIEF section 9)."),
  fuelCardMaxRows: entry(2000, "rows", "abuse", true, "Rows read from one fuel-card statement."),
  machineImportMaxRows: entry(200, "rows", "abuse", true, "Vehicles in one CSV import; import again for more."),
  bankStatementMaxRows: entry(2000, "rows", "abuse", true, "Lines in one bank statement import."),
  readingsImportMaxBytes: entry(2 * MIB, "bytes", "abuse", true, "A readings sheet for the import review (task B5), the same reviewed cap as fuel-card CSV."),
  readingsImportMaxRows: entry(2000, "rows", "abuse", true, "Readings staged from one sheet; public.import_rows_stage refuses more in one call."),
  partnerLogoMaxBytes: entry(2_000_000, "bytes", "abuse", true, "A partner's letterhead logo."),
  partnerLogoBucketBytes: entry(2 * MIB, "bytes", "abuse", false, "partner-branding bucket, a little above the form's cap."),

  // == Request bodies that are never files =============================================
  webhookBodyMaxBytes: entry(MIB, "bytes", "abuse", false, "Paystack webhook bodies are a few kilobytes."),
  apiBodyMaxBytes: entry(16 * KIB, "bytes", "abuse", false, "Public API writes are small JSON."),
  cspReportMaxBytes: entry(16 * KIB, "bytes", "abuse", false, "A CSP violation report."),
  routingBodyMaxBytes: entry(16 * KIB, "bytes", "abuse", false, "A route request: at most 25 stops."),
  trackerBatchMaxBytes: entry(128 * KIB, "bytes", "abuse", false, "One tracker position batch."),
  offlinePayloadMaxChars: entry(20_000, "chars", "abuse", false, "One queued offline capture's fields."),
  requestClaimOutcomeChars: entry(65_536, "chars", "abuse", false, "An answer a request claim keeps for a replay (20261119110000); a longer one is not kept."),

  // == Display and query windows (never contractual history limits) ====================
  readAllMaxRows: entry(100_000, "rows", "window", false, "Paged reads stop and report beyond this."),
  journalMaxLines: entry(100_000, "rows", "window", false, "Accounting journal export; choose a shorter period beyond."),
  positionRecentMs: entry(10 * MINUTE, "ms", "window", true,
    "A reported position older than this is shown as the last known position with its age, never as current or live."),
  tripReportWindowDays: entry(90, "count", "window", true, "The trip earnings report covers the last 90 days and says so; older trips stay on their own pages and in the export."),

  // == The complete export with files (20261120110000) ====================================
  exportPartBytes: entry(40 * MB, "bytes", "provider", false,
    "About 40 MB per ZIP part: under a 50 MB per-object upload limit (a Free project's ceiling, Supabase Storage file limits) with room for headers; a larger file goes alone in its own part."),
  exportMaxFiles: entry(200_000, "count", "abuse", true, "Files listed for one complete export; beyond it the contents list says the export is capped."),
  exportsPerDay: entry(5, "count", "abuse", true, "Complete exports a business may start in one South African day; each copies every file."),
  exportKeepDays: entry(7, "count", "window", true, "A finished export is kept for download seven days at most, never past the owner's last reading day."),
  exportLinkMs: entry(10 * MINUTE, "ms", "window", true, "A download link to one part works for ten minutes; a new one is made on every press while the export is kept."),
  exportFileAttempts: entry(3, "count", "abuse", false, "Attempts at one file before the export reports it missing with its reason."),
} as const satisfies Record<string, LimitEntry>;

export type LimitName = keyof typeof LIMITS;

// == Named constants code reads =========================================================

export const PHOTO_MAX_BYTES = LIMITS.photoMaxBytes.value;
export const PDF_MAX_BYTES = LIMITS.pdfMaxBytes.value;
export const VOICE_NOTE_MAX_BYTES = LIMITS.voiceNoteMaxBytes.value;
export const POSITION_RECENT_MS = LIMITS.positionRecentMs.value;
export const REQUEST_CLAIM_OUTCOME_CHARS = LIMITS.requestClaimOutcomeChars.value;
export const TRIP_REPORT_WINDOW_DAYS = LIMITS.tripReportWindowDays.value;
export const VOICE_NOTE_MAX_MS = LIMITS.voiceNoteMaxMs.value;
export const COMMAND_AUDIO_MAX_MS = LIMITS.commandAudioMaxMs.value;
export const COMMAND_AUDIO_MAX_BYTES = LIMITS.commandAudioMaxBytes.value;
export const RECORDING_WARN_BEFORE_MS = LIMITS.recordingWarnBeforeMs.value;
export const RECORDER_AUDIO_BPS = LIMITS.recorderAudioBitsPerSecond.value;
export const RECORDING_MIN_MS = LIMITS.recordingMinMs.value;
export const IMAGE_MAX_PIXELS = LIMITS.imageMaxPixels.value;
export const IMAGE_MAX_EDGE = LIMITS.imageMaxEdge.value;
export const PHOTO_LONG_EDGE = LIMITS.photoLongEdge.value;
export const PHOTO_JPEG_QUALITY = LIMITS.photoJpegQualityPercent.value / 100;
export const PHOTO_JPEG_QUALITY_MIN = LIMITS.photoJpegQualityMinPercent.value / 100;
export const RESUMABLE_THRESHOLD_BYTES = LIMITS.resumableThresholdBytes.value;
export const RESUMABLE_CHUNK_BYTES = LIMITS.resumableChunkBytes.value;
export const SIGNED_UPLOAD_TTL_MS = LIMITS.signedUploadTtlMs.value;
export const UPLOAD_INTENT_TTL_MS = LIMITS.uploadIntentTtlMs.value;
export const STORAGE_GLOBAL_LIMIT_NEEDED_BYTES = LIMITS.storageGlobalLimitNeededBytes.value;
export const SNIFF_HEAD_BYTES = LIMITS.sniffHeadBytes.value;
export const SNIFF_TAIL_BYTES = LIMITS.sniffTailBytes.value;
export const OPEN_INTENTS_PER_USER = LIMITS.openIntentsPerUser.value;
export const FUNCTION_BODY_MAX_BYTES = LIMITS.functionBodyMaxBytes.value;
export const LEGACY_MULTIPART_MAX_BYTES = LIMITS.legacyMultipartMaxBytes.value;
export const SERVER_ACTION_BODY_MAX_BYTES = LIMITS.serverActionBodyMaxBytes.value;
export const HEARING_CLIP_MAX_BYTES = LIMITS.hearingClipMaxBytes.value;
export const LIVE_DICTATION_MAX_MS = LIMITS.liveDictationMaxMs.value;
export const INSTANT_CLIP_MAX_MS = LIMITS.instantClipMaxMs.value;
export const CLIP_MIN_BYTES = LIMITS.clipMinBytes.value;
export const RECOGNISE_FILE_MAX_BYTES = LIMITS.recogniseFileMaxBytes.value;
export const ASSISTANT_TYPED_MAX_CHARS = LIMITS.assistantTypedMaxChars.value;
export const ASSISTANT_SPOKEN_MAX_CHARS = LIMITS.assistantSpokenMaxChars.value;
export const COMMAND_AUDIO_RECOVERY_MS = LIMITS.commandAudioRecoveryMs.value;
export const COMMAND_JOB_MAX_ATTEMPTS = LIMITS.commandJobMaxAttempts.value;
export const COMMAND_JOB_LEASE_MS = LIMITS.commandJobLeaseMs.value;
export const WHATSAPP_IMAGE_MAX_BYTES = LIMITS.whatsappImageMaxBytes.value;
export const WHATSAPP_VOICE_MAX_BYTES = LIMITS.whatsappVoiceMaxBytes.value;
export const WHATSAPP_VOICE_MAX_MS = LIMITS.whatsappVoiceMaxMs.value;
export const WHATSAPP_VOICE_MIN_MS = LIMITS.whatsappVoiceMinMs.value;
export const FUEL_CARD_CSV_MAX_BYTES = LIMITS.fuelCardCsvMaxBytes.value;
export const FUEL_CARD_MAX_ROWS = LIMITS.fuelCardMaxRows.value;
export const MACHINE_IMPORT_MAX_ROWS = LIMITS.machineImportMaxRows.value;
export const BANK_STATEMENT_MAX_ROWS = LIMITS.bankStatementMaxRows.value;
export const READINGS_IMPORT_MAX_BYTES = LIMITS.readingsImportMaxBytes.value;
export const READINGS_IMPORT_MAX_ROWS = LIMITS.readingsImportMaxRows.value;
export const PARTNER_LOGO_MAX_BYTES = LIMITS.partnerLogoMaxBytes.value;
export const WEBHOOK_BODY_MAX_BYTES = LIMITS.webhookBodyMaxBytes.value;
export const API_BODY_MAX_BYTES = LIMITS.apiBodyMaxBytes.value;
export const CSP_REPORT_MAX_BYTES = LIMITS.cspReportMaxBytes.value;
export const ROUTING_BODY_MAX_BYTES = LIMITS.routingBodyMaxBytes.value;
export const TRACKER_BATCH_MAX_BYTES = LIMITS.trackerBatchMaxBytes.value;
export const OFFLINE_PAYLOAD_MAX_CHARS = LIMITS.offlinePayloadMaxChars.value;
export const READ_ALL_MAX_ROWS = LIMITS.readAllMaxRows.value;
export const JOURNAL_MAX_LINES = LIMITS.journalMaxLines.value;
export const STORAGE_MIN_BYTES = LIMITS.storageMinBytes.value;
export const EXPORT_PART_BYTES = LIMITS.exportPartBytes.value;
export const EXPORT_MAX_FILES = LIMITS.exportMaxFiles.value;
export const EXPORTS_PER_DAY = LIMITS.exportsPerDay.value;
export const EXPORT_KEEP_DAYS = LIMITS.exportKeepDays.value;
export const EXPORT_LINK_MS = LIMITS.exportLinkMs.value;
export const EXPORT_FILE_ATTEMPTS = LIMITS.exportFileAttempts.value;
export const STORAGE_PER_FULL_SPACE_BYTES = LIMITS.storagePerFullSpaceBytes.value;
export const STORAGE_PER_EQUIPMENT_SPACE_BYTES = LIMITS.storagePerEquipmentSpaceBytes.value;
export const STORAGE_BLOCK_BYTES = LIMITS.storageBlockBytes.value;
export const STORAGE_WARN_PERCENT = LIMITS.storageWarnPercent.value;
export const STORAGE_URGENT_PERCENT = LIMITS.storageUrgentPercent.value;

// == Media classes: what each kind of attachment may be ================================

export type MediaClass = "photo" | "pdf" | "voice" | "command_audio";

/** The types we store, by what the file's own bytes say (never its name or declared type). */
export const PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export const PDF_MIMES = ["application/pdf"] as const;
/** What MediaRecorder produces: WebM/Opus (Chrome, Android, Edge), Ogg/Opus (Firefox), MP4/AAC (Safari). */
export const AUDIO_MIMES = ["audio/webm", "audio/ogg", "audio/mp4"] as const;
export type StoredMime = (typeof PHOTO_MIMES)[number] | (typeof PDF_MIMES)[number] | (typeof AUDIO_MIMES)[number];

export const MEDIA_CLASSES: Record<MediaClass, { maxBytes: number; maxMs: number | null; mimes: readonly StoredMime[] }> = {
  photo: { maxBytes: PHOTO_MAX_BYTES, maxMs: null, mimes: PHOTO_MIMES },
  pdf: { maxBytes: PDF_MAX_BYTES, maxMs: null, mimes: PDF_MIMES },
  voice: { maxBytes: VOICE_NOTE_MAX_BYTES, maxMs: VOICE_NOTE_MAX_MS, mimes: AUDIO_MIMES },
  command_audio: { maxBytes: COMMAND_AUDIO_MAX_BYTES, maxMs: COMMAND_AUDIO_MAX_MS, mimes: AUDIO_MIMES },
};

/** The class a stored type belongs to. */
export function mediaClassOf(mime: string, purpose: "attachment" | "command_audio" = "attachment"): MediaClass | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  if ((PHOTO_MIMES as readonly string[]).includes(base)) return "photo";
  if ((PDF_MIMES as readonly string[]).includes(base)) return "pdf";
  if ((AUDIO_MIMES as readonly string[]).includes(base) || base === "video/webm") {
    return purpose === "command_audio" ? "command_audio" : "voice";
  }
  return null;
}

/**
 * The most a file of this declared type may be, for the legacy paths that still judge a
 * File by its type before the pipeline's byte check: images 20 MB, PDFs 50 MB, recordings
 * 20 MB, anything else nothing. A declared type decides nothing on the new pipeline.
 */
export function maxBytesForMime(mime: string): number {
  const cls = mediaClassOf(mime);
  if (cls) return MEDIA_CLASSES[cls].maxBytes;
  return mime.toLowerCase().startsWith("image/") ? PHOTO_MAX_BYTES : 0;
}

// == Storage buckets: what Supabase itself refuses ======================================
//
// Each bucket refuses a file larger than the largest class it holds, or of a type it never
// holds. The per-class limit (a 20 MB photo in a bucket that also takes 50 MB PDFs) is
// enforced on the REAL bytes at finalisation. supabase/tests and limits.test.ts check the
// migration that configures the buckets against this table.

export type BucketSpec = { maxBytes: number; mimes: readonly string[] };

const IMAGE_ANY = ["image/*"] as const;
const IMAGE_OR_PDF = ["image/*", "application/pdf"] as const;
/** Some browsers label an audio-only WebM recording video/webm; the server refuses a video track. */
const AUDIO_ANY = ["audio/*", "video/webm"] as const;

export const BUCKETS = {
  "chat-files": { maxBytes: PDF_MAX_BYTES, mimes: ["image/jpeg","image/png","image/webp","image/heic","image/heif","application/pdf","audio/webm","audio/ogg","audio/mp4"] },
  "machine-photos": { maxBytes: PHOTO_MAX_BYTES, mimes: IMAGE_ANY },
  "fault-photos": { maxBytes: PHOTO_MAX_BYTES, mimes: IMAGE_ANY },
  "checklist-photos": { maxBytes: PHOTO_MAX_BYTES, mimes: IMAGE_ANY },
  "fault-voice": { maxBytes: VOICE_NOTE_MAX_BYTES, mimes: AUDIO_ANY },
  "jobcard-photos": { maxBytes: PDF_MAX_BYTES, mimes: IMAGE_OR_PDF },
  "machine-docs": { maxBytes: PDF_MAX_BYTES, mimes: IMAGE_OR_PDF },
  "partner-docs": { maxBytes: PDF_MAX_BYTES, mimes: IMAGE_OR_PDF },
  "partner-receipts": { maxBytes: PDF_MAX_BYTES, mimes: IMAGE_OR_PDF },
  "finance-docs": { maxBytes: PDF_MAX_BYTES, mimes: IMAGE_OR_PDF },
  "billing-proofs": { maxBytes: PDF_MAX_BYTES, mimes: IMAGE_OR_PDF },
  "command-audio": { maxBytes: COMMAND_AUDIO_MAX_BYTES, mimes: AUDIO_ANY },
  "partner-branding": {
    maxBytes: LIMITS.partnerLogoBucketBytes.value,
    mimes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  },
} as const satisfies Record<string, BucketSpec>;

export type BucketName = keyof typeof BUCKETS;

/** Whole decimal megabytes for a sentence ("up to 20 MB"). */
export function megabytes(bytes: number): number {
  return Math.round(bytes / MB);
}

/** Whole minutes for a sentence ("up to 10 minutes"). */
export function minutes(ms: number): number {
  return Math.round(ms / MINUTE);
}
