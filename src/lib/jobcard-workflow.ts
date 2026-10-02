import { parseRandsToCents } from "./money";

export type JobWork = {
  work_mode: string;
  workshop_id: string | null;
  status: string;
  locked: boolean;
};

export const ACTIVE_JOB_STATUSES = ["reported", "open", "in_progress", "waiting_parts"] as const;

export function isJobEditableStatus(status: string): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

export function canReviewJob(role: string | null): boolean {
  return role === "owner" || role === "manager" || role === "rr_admin";
}

export function canReturnJob(job: Pick<JobWork, "status" | "locked"> & { completion_effects_recorded: boolean }, requestStatus: string | null, hasSupplierInvoice: boolean): boolean {
  return job.status === "completed" && job.completion_effects_recorded && !job.locked && !hasSupplierInvoice && !["invoiced", "closed"].includes(requestStatus ?? "");
}

/** Editing the provider's work and accepting it are separate permissions. */
export function canEditJobWork(job: JobWork, role: string | null, workshopId: string | null): boolean {
  if (job.locked || !isJobEditableStatus(job.status)) return false;
  if (role === "rr_admin") return true;
  if (job.workshop_id) return role === "workshop" && job.workshop_id === workshopId;
  if (job.work_mode === "external") return canReviewJob(role);
  return canReviewJob(role) || role === "mechanic";
}

export function needsJobMeter(type: string, meterType: string): boolean {
  return type === "scheduled_service" && meterType !== "none";
}

export function canChangeJobStatus(from: string, to: string): boolean {
  if (from === "reported" || from === "open") return to === "in_progress";
  if (from === "in_progress") return to === "waiting_parts";
  if (from === "waiting_parts") return to === "in_progress";
  return false;
}

/** Missing sections are left untouched; status changes always use lifecycle actions. */
export function jobCardPatch(form: FormData): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = {};
  for (const key of ["date_in", "date_out", "reported_problem", "diagnosis", "work_performed", "recommendations"]) {
    if (form.has(key)) patch[key] = String(form.get(key) ?? "").trim() || null;
  }
  if (form.has("meter_reading")) {
    const raw = String(form.get("meter_reading") ?? "").trim();
    const value = raw === "" ? null : Number(raw);
    if (value != null && (!Number.isFinite(value) || value < 0 || value >= 1e11)) throw new Error("job-invalid-meter");
    patch.meter_reading = value;
  }
  for (const field of ["date_in", "date_out"]) {
    const value = patch[field];
    if (typeof value === "string" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      throw new Error("job-invalid-date");
    }
  }
  if (form.has("date_in") && !patch.date_in) throw new Error("job-invalid-date");
  return patch;
}

export function parseJobLine(form: FormData) {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const kind = text("kind");
  if (!["part", "labour", "other"].includes(kind)) throw new Error("job-invalid-line");
  const description = text("description") || null;
  const part_no = kind === "part" ? text("part_no") || null : null;
  if (!description && !part_no) throw new Error("job-line-description");
  if ((description?.length ?? 0) > 2000 || (part_no?.length ?? 0) > 200) throw new Error("job-invalid-line");
  const positive = (key: string) => {
    const raw = text(key);
    const value = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value >= 1e10 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error("job-line-quantity");
    return value;
  };
  const money = (key: string) => {
    const raw = text(key);
    if (!raw) return null;
    const value = parseRandsToCents(raw);
    if (value == null || value < 0 || !Number.isSafeInteger(value)) throw new Error("job-line-price");
    return value;
  };
  return {
    kind, description, part_no,
    qty: kind === "part" ? positive("qty") : null,
    hours: kind === "labour" ? positive("hours") : null,
    unit_cost_cents: kind === "labour" ? null : money("unit_cost"),
    rate_cents: kind === "labour" ? money("rate") : null,
  };
}
