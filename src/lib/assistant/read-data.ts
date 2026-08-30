import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth";
import { matchMachine, normalizeAssistantText } from "./normalize";
import type { AssistantDocumentStatus, AssistantMachine } from "./types";

export type AssistantReadScope = {
  supabase: SupabaseClient;
  farmId: string;
  role: Role;
  machines: AssistantMachine[];
};

export type MachineResolution =
  | { ok: true; machine: AssistantMachine }
  | { ok: false; reason: "not_found" | "ambiguous"; alternatives: string[] };

export type FleetSearchResult = {
  match?: MachineResolution;
  machines: Array<{
    name: string;
    make: string | null;
    model: string | null;
    status: string;
    meterType: string;
    currentReading: number | null;
    currentReadingDate: string | null;
    serviceStatus: AssistantMachine["serviceStatus"];
    nextDueDate: string | null;
    nextDueReading: number | null;
  }>;
};

export type FaultReadRow = {
  machine: string;
  description: string | null;
  category: string | null;
  urgency: unknown;
  status: unknown;
  reportedAt: unknown;
};

export type JobCardReadRow = {
  machine: string;
  type: unknown;
  status: unknown;
  dateIn: unknown;
  dateOut: unknown;
  problem: string | null;
  diagnosis: string | null;
  workPerformed: string | null;
  totalCents: number | null;
};

export type WorkRequestReadRow = {
  machine: string;
  kind: unknown;
  status: unknown;
  priority: unknown;
  title: string | null;
  description: string | null;
  quoteAmountCents: number | null;
  invoiceAmountCents: number | null;
  updatedAt: unknown;
};

export type DocumentReadRow = {
  machine: string | null;
  kind: unknown;
  status: unknown;
  number: string | null;
  subject: string | null;
  issueDate: unknown;
  dueDate: unknown;
  currency: unknown;
  totalCents: number | null;
  outstandingCents: number | null;
};

export function resolveVisibleMachine(
  query: string | undefined,
  machines: AssistantMachine[],
): MachineResolution | null {
  if (!query?.trim()) return null;
  const match = matchMachine(query, machines);
  if (match.machine) return { ok: true, machine: match.machine };
  return {
    ok: false,
    reason: match.ambiguous ? "ambiguous" : "not_found",
    alternatives: match.alternatives.map((machine) => machine.name).slice(0, 5),
  };
}

function machineNameById(machines: AssistantMachine[]): Map<string, string> {
  return new Map(machines.map((machine) => [machine.id, machine.name]));
}

function cents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function concise(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, max) : null;
}

function visibleIds(scope: AssistantReadScope): string[] {
  return scope.machines.map((machine) => machine.id);
}

function canSeeOperationalAmounts(role: Role): boolean {
  return role !== "operator";
}

export function canReadFinancialDocuments(role: Role): boolean {
  return ["rr_admin", "owner", "manager", "mechanic"].includes(role);
}

export async function searchFleet(
  scope: AssistantReadScope,
  input: { query?: string; limit?: number } = {},
): Promise<FleetSearchResult> {
  const normalized = input.query ? normalizeAssistantText(input.query) : "";
  const exact = input.query ? resolveVisibleMachine(input.query, scope.machines) : null;
  const candidates = exact?.ok
    ? [exact.machine]
    : scope.machines.filter((machine) => {
        if (!normalized) return true;
        return [machine.name, machine.make, machine.model, ...machine.aliases]
          .filter((value): value is string => Boolean(value))
          .some((value) => normalizeAssistantText(value).includes(normalized));
      });
  return {
    match: exact && !exact.ok ? exact : undefined,
    machines: candidates.slice(0, input.limit ?? 15).map((machine) => ({
      name: machine.name,
      make: machine.make,
      model: machine.model,
      status: machine.status,
      meterType: machine.meterType,
      currentReading: machine.currentReading,
      currentReadingDate: machine.currentReadingDate,
      serviceStatus: machine.serviceStatus,
      nextDueDate: machine.nextDueDate,
      nextDueReading: machine.nextDueReading,
    })),
  };
}

export async function listFaults(
  scope: AssistantReadScope,
  input: { machine?: string; view?: "open" | "resolved" | "all"; limit?: number } = {},
): Promise<{ match?: MachineResolution; faults: FaultReadRow[] }> {
  const resolved = resolveVisibleMachine(input.machine, scope.machines);
  if (resolved && !resolved.ok) return { match: resolved, faults: [] };
  const names = machineNameById(scope.machines);
  let query = scope.supabase
    .from("faults")
    .select("machine_id, description, category, urgency, status, created_at")
    .eq("farm_id", scope.farmId)
    .in("machine_id", visibleIds(scope))
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 10);
  if (input.view === "resolved") query = query.eq("status", "resolved");
  else if (input.view !== "all") query = query.neq("status", "resolved");
  if (resolved?.ok) query = query.eq("machine_id", resolved.machine.id);
  const { data, error } = await query;
  if (error) throw error;
  return {
    match: resolved ?? undefined,
    faults: ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
      machine: names.get(String(row.machine_id)) ?? "Unknown machine",
      description: concise(row.description),
      category: concise(row.category, 80),
      urgency: row.urgency,
      status: row.status,
      reportedAt: row.created_at,
    })),
  };
}

export async function listJobCards(
  scope: AssistantReadScope,
  input: {
    machine?: string;
    view?: "active" | "completed" | "all";
    type?: "scheduled_service" | "repair" | "inspection" | "other";
    limit?: number;
  } = {},
): Promise<{ match?: MachineResolution; jobCards: JobCardReadRow[] }> {
  const resolved = resolveVisibleMachine(input.machine, scope.machines);
  if (resolved && !resolved.ok) return { match: resolved, jobCards: [] };
  const names = machineNameById(scope.machines);
  const showAmounts = canSeeOperationalAmounts(scope.role);
  let query = scope.supabase
    .from("job_cards")
    .select("machine_id, type, status, date_in, date_out, reported_problem, diagnosis, work_performed, total_cents, created_at")
    .eq("farm_id", scope.farmId)
    .in("machine_id", visibleIds(scope))
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 10);
  if (input.view === "completed") query = query.in("status", ["completed", "approved"]);
  else if (input.view !== "all") query = query.in("status", ["reported", "open", "in_progress", "waiting_parts"]);
  if (input.type) query = query.eq("type", input.type);
  if (resolved?.ok) query = query.eq("machine_id", resolved.machine.id);
  const { data, error } = await query;
  if (error) throw error;
  return {
    match: resolved ?? undefined,
    jobCards: ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
      machine: names.get(String(row.machine_id)) ?? "Unknown machine",
      type: row.type,
      status: row.status,
      dateIn: row.date_in,
      dateOut: row.date_out,
      problem: concise(row.reported_problem),
      diagnosis: concise(row.diagnosis),
      workPerformed: concise(row.work_performed),
      totalCents: showAmounts ? cents(row.total_cents) : null,
    })),
  };
}

export async function listWorkRequests(
  scope: AssistantReadScope,
  input: {
    machine?: string;
    kind?: "repair" | "quote" | "inspection" | "parts" | "other";
    view?: "active" | "all";
    status?: "requested" | "viewed" | "quoted" | "accepted" | "in_progress" | "completed" | "invoiced" | "closed";
    limit?: number;
  } = {},
): Promise<{ match?: MachineResolution; workRequests: WorkRequestReadRow[] }> {
  const resolved = resolveVisibleMachine(input.machine, scope.machines);
  if (resolved && !resolved.ok) return { match: resolved, workRequests: [] };
  const names = machineNameById(scope.machines);
  const showAmounts = canSeeOperationalAmounts(scope.role);
  let query = scope.supabase
    .from("work_requests")
    .select("machine_id, kind, status, priority, title, description, quote_amount_cents, invoice_amount_cents, updated_at")
    .eq("farm_id", scope.farmId)
    .in("machine_id", visibleIds(scope))
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(input.limit ?? 10);
  if (resolved?.ok) query = query.eq("machine_id", resolved.machine.id);
  if (input.kind) query = query.eq("kind", input.kind);
  if (input.status) query = query.eq("status", input.status);
  else if (input.view !== "all") query = query.in("status", ["requested", "viewed", "quoted", "accepted", "in_progress"]);
  const { data, error } = await query;
  if (error) throw error;
  return {
    match: resolved ?? undefined,
    workRequests: ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
      machine: names.get(String(row.machine_id)) ?? "Unknown machine",
      kind: row.kind,
      status: row.status,
      priority: row.priority,
      title: concise(row.title, 160),
      description: concise(row.description),
      quoteAmountCents: showAmounts ? cents(row.quote_amount_cents) : null,
      invoiceAmountCents: showAmounts ? cents(row.invoice_amount_cents) : null,
      updatedAt: row.updated_at,
    })),
  };
}

export async function listDocuments(
  scope: AssistantReadScope,
  input: {
    machine?: string;
    kind?: "quote" | "invoice";
    status?: AssistantDocumentStatus;
    outstandingOnly?: boolean;
    limit?: number;
  } = {},
): Promise<{ access?: "forbidden_for_role"; match?: MachineResolution; documents: DocumentReadRow[] }> {
  if (!canReadFinancialDocuments(scope.role)) return { access: "forbidden_for_role", documents: [] };
  const resolved = resolveVisibleMachine(input.machine, scope.machines);
  if (resolved && !resolved.ok) return { match: resolved, documents: [] };
  const names = machineNameById(scope.machines);
  let query = scope.supabase
    .from("partner_documents")
    .select("machine_id, kind, status, number, subject, issue_date, due_date, currency, total_cents, amount_paid_cents")
    .eq("farm_id", scope.farmId)
    .is("deleted_at", null)
    .order("issue_date", { ascending: false })
    .limit(input.limit ?? 10);
  if (resolved?.ok) query = query.eq("machine_id", resolved.machine.id);
  if (input.outstandingOnly) {
    query = query.eq("kind", "invoice").in("status", ["sent", "part_paid"]);
  } else {
    if (input.kind) query = query.eq("kind", input.kind);
    if (input.status) query = query.eq("status", input.status);
  }
  const { data, error } = await query;
  if (error) throw error;
  return {
    match: resolved ?? undefined,
    documents: ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => {
      const total = cents(row.total_cents);
      const paid = cents(row.amount_paid_cents);
      return {
        machine: row.machine_id ? names.get(String(row.machine_id)) ?? "Unknown machine" : null,
        kind: row.kind,
        status: row.status,
        number: concise(row.number, 80),
        subject: concise(row.subject, 160),
        issueDate: row.issue_date,
        dueDate: row.due_date,
        currency: row.currency,
        totalCents: total,
        outstandingCents: total != null && paid != null ? Math.max(0, total - paid) : null,
      };
    }),
  };
}
