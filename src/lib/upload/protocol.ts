/**
 * What the browser and the server say to each other about one upload. Pure, shared by the
 * client helper (client.ts), the routes and the tests.
 */

export const TARGET_KINDS = [
  "machine", "fault", "checklist_instance", "job_card", "work_request", "trip_job",
  "finance_agreement", "asset_contract", "partner_document", "partner_expense",
  "billing_payment", "assistant_command", "chat_message",
] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const isTargetKind = (value: unknown): value is TargetKind =>
  typeof value === "string" && (TARGET_KINDS as readonly string[]).includes(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** The word in the object name, before the intent id: photo, voice, quote, invoice, ... */
export const LABEL_PATTERN = /^[a-z]{2,16}$/;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
  "application/pdf": "pdf", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a",
};
export const extensionFor = (mime: string): string | null => EXTENSIONS[mime.split(";")[0].trim().toLowerCase()] ?? null;

/** Every refusal the pipeline can give; each has a sentence in errors.ts and both languages. */
export type UploadCode =
  | "forbidden" | "farm-not-active"
  | "upload-too-large" | "upload-too-large-for-storage" | "upload-wrong-type" | "upload-storage-full"
  | "upload-target" | "upload-too-many" | "upload-request-reused" | "upload-expired" | "upload-too-long"
  | "upload-not-received" | "upload-malformed" | "upload-too-many-pixels" | "upload-unsupported-codec"
  | "upload-video-not-supported" | "upload-empty" | "upload-not-attached" | "upload-unavailable" | "upload-interrupted";

export type BeginAnswer =
  | {
      state: "upload";
      intentId: string;
      bucket: string;
      path: string;
      /** The signed upload token: PUT with ?token=, or TUS with the x-signature header. */
      token: string;
      signedUrl: string;
      resumable: boolean;
      tusEndpoint: string;
      chunkBytes: number;
      expiresAt: string;
    }
  | { state: "uploaded" | "finalised"; intentId: string };
