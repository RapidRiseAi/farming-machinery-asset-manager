export const ASSISTANT_LOCALES = ["en-ZA", "af-ZA"] as const;
export type AssistantLocale = (typeof ASSISTANT_LOCALES)[number];

export const ASSISTANT_INTENTS = [
  "report_fault",
  "log_reading",
  "log_service",
  "query_asset_status",
  "query_service_due",
] as const;
export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

export type AssistantChannel = "typed" | "voice";
export type AssistantUrgency = "can_work" | "limping" | "stopped";

export type AssistantMachine = {
  id: string;
  name: string;
  make: string | null;
  model: string | null;
  aliases: string[];
  status: string;
  meterType: string;
  currentReading: number | null;
  currentReadingDate: string | null;
  serviceStatus: "ok" | "due_soon" | "overdue" | null;
  nextDueDate: string | null;
  nextDueReading: number | null;
};

/** A server-side interpretation. It is never an authority to write by itself. */
export type AssistantDraft = {
  intent: AssistantIntent | null;
  machineQuery: string | null;
  machineId: string | null;
  description: string | null;
  category: string | null;
  urgency: AssistantUrgency | null;
  reading: number | null;
  readingDate: string | null;
  serviceDate: string | null;
  workPerformed: string | null;
  confidence: number;
};

export type AssistantField =
  | {
      name: "machineId";
      type: "select";
      label: string;
      options: Array<{ value: string; label: string }>;
    }
  | {
      name: "description" | "workPerformed";
      type: "text";
      label: string;
      value?: string;
    }
  | {
      name: "reading";
      type: "number";
      label: string;
      value?: number;
      min?: number;
      step?: number;
    }
  | {
      name: "readingDate" | "serviceDate";
      type: "date";
      label: string;
      value?: string;
    };

export type AssistantClarification = {
  interactionId: string;
  machineId?: string;
  description?: string;
  workPerformed?: string;
  reading?: number;
  readingDate?: string;
  serviceDate?: string;
};

export type AssistantTurnRequest = {
  input: string;
  locale: AssistantLocale;
  channel: AssistantChannel;
  voiceCaptureId?: string;
  /** Earlier voice captures made non-actionable when this corrected/retried text is submitted. */
  supersedesVoiceCaptureIds?: string[];
  sttConfidence?: number;
  clarification?: AssistantClarification;
};

export type ConfirmationProposal = {
  proposalId: string;
  title: string;
  intent: AssistantIntent;
  machineName: string;
  facts: Array<{ label: string; value: string }>;
  expiresAt: string;
};

export type AssistantTurnResponse =
  | {
      kind: "clarify";
      conversationId: string;
      question: string;
      fields: AssistantField[];
    }
  | {
      kind: "confirm";
      conversationId: string;
      proposal: ConfirmationProposal;
    }
  | {
      kind: "answer";
      conversationId: string;
      message: string;
      speakText?: string;
    }
  | {
      kind: "needs_consent";
      conversationId: string;
      explanation: string;
    }
  | {
      kind: "error";
      code: string;
      message: string;
      fallbackHref?: string;
    };

export type AssistantConfirmResponse =
  | {
      ok: true;
      message: string;
      linkedRecordType: string;
      linkedRecordId: string;
      href: string;
    }
  | { ok: false; code: string; message: string };

export function isAssistantLocale(value: unknown): value is AssistantLocale {
  return typeof value === "string" && (ASSISTANT_LOCALES as readonly string[]).includes(value);
}

export function isAssistantIntent(value: unknown): value is AssistantIntent {
  return typeof value === "string" && (ASSISTANT_INTENTS as readonly string[]).includes(value);
}
