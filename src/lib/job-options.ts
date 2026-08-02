/**
 * Job-card option lists, shared by the server actions and the screens that offer them.
 *
 * These live here rather than in `jobcards/actions.ts` because a `"use server"` file may
 * only export async functions — and the job-card list needs the type list to offer a
 * real choice instead of hardcoding `type="repair"` on every card it creates.
 */
export const JOB_TYPES = ["scheduled_service", "repair", "inspection", "other"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "reported",
  "open",
  "in_progress",
  "waiting_parts",
  "completed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const LINE_KINDS = ["part", "labour", "other"] as const;
export type LineKind = (typeof LINE_KINDS)[number];
