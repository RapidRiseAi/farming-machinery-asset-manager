// Offline mutation queue — shared types.
//
// A "mutation" is one field capture (a reading, a fault, a job-card line, a job
// completion) recorded on-device while offline. It carries a client-generated
// idempotency UUID + client timestamp so the /api/sync route can apply it exactly
// once. Conflicts remain reviewable and cannot roll a machine's meter backwards.

export type MutationType =
  | "log_reading"
  | "report_fault"
  | "add_job_line"
  | "complete_job";

export type MutationScope = "app" | "public";

export type QueuedMutation = {
  /** Client idempotency key (UUID v4). Stable across flush retries. */
  client_id: string;
  /** Account that captured the draft; never inferred from the account replaying it. */
  actor_id?: string;
  /** Retained rejects/conflicts are reviewable rather than silently discarded. */
  sync_error?: string;
  /** Client capture time (ISO 8601), retained for history and retry identity. */
  client_ts: string;
  type: MutationType;
  scope: MutationScope;
  /** Plain string fields, mirroring the online form field names. */
  fields: Record<string, string>;
  /** Optional captured media (fault photo / voice note). */
  photo?: Blob;
  voice?: Blob;
  /** When it was queued (for ordering + display). */
  queued_at: number;
};

export type SyncStatusValue = "applied" | "duplicate" | "conflict" | "pending";
