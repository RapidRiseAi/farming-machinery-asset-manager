/**
 * Work-request flow (F12b) — shared lifecycle constants + label/badge helpers so the
 * list page, detail page and server actions all agree on the enum values and rendering.
 * The status lifecycle mirrors migration 0310:
 *   requested → viewed → quoted → accepted → in_progress → completed → invoiced → closed
 */
import { t, type Locale } from "@/lib/i18n";

export const WORK_KINDS = ["repair", "quote", "inspection", "parts", "other"] as const;
export const WORK_STATUSES = [
  "requested", "viewed", "quoted", "accepted",
  "in_progress", "completed", "invoiced", "closed",
] as const;
export const WORK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type WorkPriority = (typeof WORK_PRIORITIES)[number];

export function isWorkKind(v: string): v is WorkKind {
  return (WORK_KINDS as readonly string[]).includes(v);
}
export function isWorkStatus(v: string): v is WorkStatus {
  return (WORK_STATUSES as readonly string[]).includes(v);
}
export function isWorkPriority(v: string): v is WorkPriority {
  return (WORK_PRIORITIES as readonly string[]).includes(v);
}

export const workKindLabel = (k: string, locale: Locale) => t(`workKind.${k}`, locale);
export const workStatusLabel = (s: string, locale: Locale) => t(`workStatus.${s}`, locale);
export const workPriorityLabel = (p: string, locale: Locale) => t(`workPriority.${p}`, locale);

/** 0-based index of a status along the lifecycle (for the stepper). -1 if unknown. */
export function workStatusStep(s: string): number {
  return (WORK_STATUSES as readonly string[]).indexOf(s);
}

type Tone = "neutral" | "info" | "ok" | "warning" | "danger";

/** Badge tone for a status (traffic-light-ish: closed/complete = ok, invoiced = info…). */
export function workStatusTone(s: string): Tone {
  switch (s) {
    case "closed":
    case "completed":
      return "ok";
    case "invoiced":
    case "accepted":
      return "info";
    case "quoted":
      return "warning";
    case "requested":
    case "viewed":
    case "in_progress":
    default:
      return "neutral";
  }
}

/** Priority tone (urgent = red, high = amber). */
export function workPriorityTone(p: string): Tone {
  switch (p) {
    case "urgent":
      return "danger";
    case "high":
      return "warning";
    default:
      return "neutral";
  }
}
