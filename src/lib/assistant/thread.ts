import { proposalFor } from "./presentation";
import { isSafeAssistantMachineHref } from "./identifiers";
import {
  ASSISTANT_INTENTS,
  ASSISTANT_LOCALES,
  type AssistantDraft,
  type AssistantLocale,
  type AssistantMachine,
  type AssistantUrgency,
  type ConfirmationProposal,
} from "./types";

/**
 * The assistant's conversation history, as a view of `public.ai_interactions`.
 *
 * Pure on purpose: every decision about what a stored row MEANS to the person
 * who made it lives here, so it can be tested without a database. The loader in
 * `history.ts` only fetches and hands rows to `toThreadEntry`.
 *
 * See docs/ASSISTANT_THREAD_PLAN.md for why this is read from the table rather
 * than kept in React state.
 */

/** Columns the loader selects. `tool_args` is read server-side only, see `toThreadEntry`. */
export const THREAD_COLUMNS =
  "id, created_at, channel, locale, input_text, response_text, confirmation_status, result_status, error_code, proposal_expires_at, linked_record_type, linked_record_id, tool_args";

/** How many past exchanges the assistant opens with. */
export const THREAD_LIMIT = 20;

export type ThreadRow = {
  id: string;
  created_at: string;
  channel: string;
  locale: string;
  input_text: string | null;
  response_text: string | null;
  confirmation_status: string;
  result_status: string;
  error_code: string | null;
  proposal_expires_at: string | null;
  linked_record_type: string | null;
  linked_record_id: string | null;
  tool_args: unknown;
};

export type ThreadStatus =
  /** A question that was answered. The answer is the whole story; no chip. */
  | "answered"
  /** A confirmed change that was saved. */
  | "applied"
  /** A proposal the person declined. */
  | "rejected"
  /** A proposal still inside its window, with its facts rebuilt so it can be reviewed. */
  | "pending"
  /** A proposal whose window closed before anyone confirmed it. */
  | "expired"
  /** A clarification that was abandoned, or a proposal that can no longer be shown. */
  | "unfinished"
  /** A voice proposal replaced by a corrected transcript. */
  | "superseded"
  /** Anything else that did not complete. */
  | "failed";

/**
 * What the browser receives. Deliberately NOT the row: no `tool_args`, no
 * provider, model, token counts or error detail. A thread entry is what the
 * person said, what came back, and where it led.
 */
export type ThreadEntry = {
  id: string;
  createdAt: string;
  channel: "typed" | "voice" | "whatsapp";
  input: string | null;
  /**
   * Shown only when the stored text was written FOR the person, an answer, or
   * the localized outcome of a confirmation. Failure rows keep English
   * diagnostics meant for support ("The selected-farm role cannot perform this
   * intent."), so those render the localized status instead.
   */
  response: string | null;
  status: ThreadStatus;
  href: string | null;
  /** Rebuilt facts for a pending proposal, so it is never confirmed blind. */
  proposal: ConfirmationProposal | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URGENCIES: readonly AssistantUrgency[] = ["can_work", "limping", "stopped"];

/**
 * The status a row carries for its subject, at `now`.
 *
 * Expiry is computed rather than read: `apply_assistant_proposal` only marks a
 * proposal failed when somebody ATTEMPTS to confirm it late. One that simply
 * aged out is still `proposed`/`pending` in the table, with its expiry in the
 * past.
 */
export function threadStatus(
  row: Pick<ThreadRow, "result_status" | "confirmation_status" | "error_code" | "proposal_expires_at">,
  now: Date,
): ThreadStatus {
  switch (row.result_status) {
    case "answered":
      return "answered";
    case "applied":
      return "applied";
    case "rejected":
      return "rejected";
    case "failed":
      if (row.error_code === "superseded") return "superseded";
      if (row.error_code === "proposal_expired") return "expired";
      return "failed";
    case "proposed": {
      if (row.confirmation_status !== "pending") return "unfinished";
      const expires = row.proposal_expires_at ? Date.parse(row.proposal_expires_at) : Number.NaN;
      // A pending proposal with no readable expiry is treated as closed: the
      // safe failure is "you cannot confirm this", never "you can".
      if (!Number.isFinite(expires) || expires <= now.getTime()) return "expired";
      return "pending";
    }
    default:
      return "failed";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Reads a stored draft back into its type, or null.
 *
 * `tool_args` is written by the server, but it is still JSON coming out of a
 * database and about to drive a confirmation card, so it is checked field by
 * field rather than cast.
 */
export function parseDraft(value: unknown): AssistantDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const intent = v.intent;
  if (intent !== null && !(ASSISTANT_INTENTS as readonly unknown[]).includes(intent)) return null;
  const reading = v.reading;
  if (reading !== null && reading !== undefined && (typeof reading !== "number" || !Number.isFinite(reading))) {
    return null;
  }
  const urgency = v.urgency;
  if (urgency !== null && urgency !== undefined && !URGENCIES.includes(urgency as AssistantUrgency)) return null;
  const confidence = typeof v.confidence === "number" && Number.isFinite(v.confidence) ? v.confidence : 0;
  return {
    intent: (intent as AssistantDraft["intent"]) ?? null,
    machineQuery: str(v.machineQuery),
    machineId: str(v.machineId),
    description: str(v.description),
    category: str(v.category),
    urgency: (urgency as AssistantUrgency | undefined) ?? null,
    reading: typeof reading === "number" ? reading : null,
    readingDate: str(v.readingDate),
    serviceDate: str(v.serviceDate),
    workPerformed: str(v.workPerformed),
    confidence,
  };
}

/**
 * Where an applied change can be opened. Mirrors the href the confirm RPC
 * returns, and applies the same safety checks the confirm route does, so a
 * history link can never point somewhere a live confirmation could not.
 */
export function threadHref(
  row: Pick<ThreadRow, "linked_record_type" | "linked_record_id">,
  draft: AssistantDraft | null,
): string | null {
  switch (row.linked_record_type) {
    case "fault":
      return "/faults";
    case "job_card":
      return row.linked_record_id && UUID.test(row.linked_record_id) ? `/jobcards/${row.linked_record_id}` : null;
    case "meter_reading": {
      const href = draft?.machineId ? `/machines/${draft.machineId}` : "";
      return isSafeAssistantMachineHref(href) ? href : null;
    }
    default:
      return null;
  }
}

const isLocale = (v: string): v is AssistantLocale => (ASSISTANT_LOCALES as readonly string[]).includes(v);
const PROPOSAL_INTENTS = new Set(["report_fault", "log_reading", "log_service"]);

/**
 * One row, as its subject should see it.
 *
 * `machines` is the list this person may currently act on. A pending proposal
 * is rebuilt only against a machine still in it: if the machine was retired, or
 * an operator lost the assignment, the proposal cannot be shown honestly and is
 * reported as unfinished rather than offered for confirmation.
 */
export function toThreadEntry(row: ThreadRow, machines: AssistantMachine[], now: Date): ThreadEntry {
  let status = threadStatus(row, now);
  const draft = parseDraft(row.tool_args);

  let proposal: ConfirmationProposal | null = null;
  if (status === "pending") {
    const machine = draft?.machineId ? machines.find((m) => m.id === draft.machineId) : undefined;
    if (draft && machine && draft.intent && PROPOSAL_INTENTS.has(draft.intent) && isLocale(row.locale) && row.proposal_expires_at) {
      proposal = proposalFor(row.id, draft, machine, row.locale, row.proposal_expires_at);
    } else {
      status = "unfinished";
    }
  }

  const input = row.input_text?.trim() || null;
  const speaksToPerson = status === "answered" || status === "applied" || status === "rejected";
  return {
    id: row.id,
    createdAt: row.created_at,
    channel: row.channel === "voice" || row.channel === "whatsapp" ? row.channel : "typed",
    input,
    response: speaksToPerson ? row.response_text?.trim() || null : null,
    status,
    href: status === "applied" ? threadHref(row, draft) : null,
    proposal,
  };
}

/** Outcomes that mean nothing happened: no answer, no record, nothing saved. */
const COLLAPSIBLE: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>([
  "expired",
  "unfinished",
  "superseded",
  "failed",
]);

/** A shorter run is left alone: folding two lines away saves nothing. */
export const THREAD_COLLAPSE_MIN = 3;

export type ThreadGroup =
  | { kind: "entry"; entry: ThreadEntry }
  | { kind: "collapsed"; id: string; entries: ThreadEntry[] };

/**
 * Fold runs of abandoned attempts into one line.
 *
 * A thread that has been tested hard fills with identical "Expired" and "Not
 * finished" entries, and the exchanges that DID something scroll away behind
 * them. Only consecutive outcomes where nothing happened are folded, and only
 * three or more of them: an answer, a saved change, a declined proposal, and a
 * pending one the person can still confirm are each always their own line.
 *
 * Grouping reads the STORED status, so a pending proposal that ages out while
 * the tab is open stays its own line. The safe direction is to hide too little.
 */
export function groupThread(entries: ThreadEntry[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  let run: ThreadEntry[] = [];

  const flush = () => {
    if (run.length >= THREAD_COLLAPSE_MIN) {
      groups.push({ kind: "collapsed", id: run[0].id, entries: run });
    } else {
      for (const entry of run) groups.push({ kind: "entry", entry });
    }
    run = [];
  };

  for (const entry of entries) {
    if (COLLAPSIBLE.has(entry.status)) {
      run.push(entry);
      continue;
    }
    flush();
    groups.push({ kind: "entry", entry });
  }
  flush();
  return groups;
}
