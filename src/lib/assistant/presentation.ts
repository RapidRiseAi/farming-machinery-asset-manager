import type {
  AssistantDraft,
  AssistantField,
  AssistantLocale,
  AssistantMachine,
  ConfirmationProposal,
} from "./types";
import { todayInSouthAfrica } from "./date";

function af(locale: AssistantLocale): boolean {
  return locale === "af-ZA";
}

export function missingFields(
  draft: AssistantDraft,
  machines: AssistantMachine[],
  locale: AssistantLocale,
  machineOptions?: AssistantMachine[],
): { question: string; fields: AssistantField[] } | null {
  const fields: AssistantField[] = [];
  if (!draft.machineId) {
    const candidates = machineOptions?.length ? machineOptions : machines;
    fields.push({
      name: "machineId",
      type: "select",
      label: af(locale) ? "Watter masjien?" : "Which machine?",
      options: candidates.map((machine) => ({ value: machine.id, label: machine.name })),
    });
  }

  if (draft.intent === "report_fault" && !draft.description?.trim()) {
    fields.push({
      name: "description",
      type: "text",
      label: af(locale) ? "Wat is die probleem?" : "What is the problem?",
    });
  }
  if (draft.intent === "log_reading" && draft.reading == null) {
    fields.push({
      name: "reading",
      type: "number",
      min: 0,
      step: 0.1,
      label: af(locale) ? "Wat is die meterlesing?" : "What is the meter reading?",
    });
  }
  if (draft.intent === "log_reading" && !draft.readingDate) {
    fields.push({
      name: "readingDate",
      type: "date",
      value: todayInSouthAfrica(),
      label: af(locale) ? "Datum van lesing" : "Reading date",
    });
  }
  if (draft.intent === "log_service" && draft.reading == null) {
    fields.push({
      name: "reading",
      type: "number",
      min: 0,
      step: 0.1,
      label: af(locale) ? "Meterlesing tydens die diens" : "Meter reading at service",
    });
  }
  if (draft.intent === "log_service" && !draft.serviceDate) {
    fields.push({
      name: "serviceDate",
      type: "date",
      value: todayInSouthAfrica(),
      label: af(locale) ? "Diensdatum" : "Service date",
    });
  }

  if (fields.length === 0) return null;
  return {
    question: af(locale)
      ? "Ek het nog ’n bietjie inligting nodig voordat ons kan voortgaan."
      : "I need a little more information before we can continue.",
    fields,
  };
}

function meter(machine: AssistantMachine, value: number): string {
  return `${new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 1 }).format(value)} ${
    machine.meterType === "hours" ? "h" : machine.meterType
  }`;
}

export function queryAnswer(
  draft: AssistantDraft,
  machine: AssistantMachine,
  locale: AssistantLocale,
): string {
  if (draft.intent === "query_asset_status") {
    const reading = machine.currentReading == null ? null : meter(machine, machine.currentReading);
    if (af(locale)) {
      return `${machine.name} se status is ${machine.status.replaceAll("_", " ")}.${
        reading ? ` Die huidige lesing is ${reading}.` : " Geen huidige meterlesing is aangeteken nie."
      }`;
    }
    return `${machine.name} is ${machine.status.replaceAll("_", " ")}.${
      reading ? ` Its current reading is ${reading}.` : " No current meter reading is recorded."
    }`;
  }

  if (!machine.serviceStatus) {
    return af(locale)
      ? `${machine.name} het nog nie ’n diensplan nie.`
      : `${machine.name} does not have a service plan yet.`;
  }
  const status = af(locale)
    ? { ok: "op datum", due_soon: "binnekort verskuldig", overdue: "agterstallig" }[machine.serviceStatus]
    : { ok: "up to date", due_soon: "due soon", overdue: "overdue" }[machine.serviceStatus];
  const due = [
    machine.nextDueReading == null ? null : meter(machine, machine.nextDueReading),
    machine.nextDueDate,
  ].filter(Boolean);
  return af(locale)
    ? `${machine.name} se diens is ${status}.${due.length ? ` Volgende teiken: ${due.join(" of ")}.` : ""}`
    : `${machine.name}'s service is ${status}.${due.length ? ` Next target: ${due.join(" or ")}.` : ""}`;
}

export function proposalFor(
  id: string,
  draft: AssistantDraft,
  machine: AssistantMachine,
  locale: AssistantLocale,
  expiresAt: string,
): ConfirmationProposal {
  const facts: Array<{ label: string; value: string }> = [
    { label: af(locale) ? "Masjien" : "Machine", value: machine.name },
  ];
  let title = "";

  if (draft.intent === "report_fault") {
    title = af(locale) ? "Meld hierdie fout aan?" : "Report this fault?";
    facts.push(
      { label: af(locale) ? "Probleem" : "Problem", value: draft.description ?? "" },
      { label: af(locale) ? "Dringendheid" : "Urgency", value: draft.urgency ?? "can_work" },
    );
    if (draft.category) facts.push({ label: af(locale) ? "Kategorie" : "Category", value: draft.category });
  } else if (draft.intent === "log_reading") {
    title = af(locale) ? "Teken hierdie lesing aan?" : "Save this reading?";
    facts.push(
      { label: af(locale) ? "Lesing" : "Reading", value: meter(machine, draft.reading ?? 0) },
      { label: af(locale) ? "Datum" : "Date", value: draft.readingDate ?? "" },
    );
  } else {
    title = af(locale) ? "Teken hierdie diens aan?" : "Save this completed service?";
    facts.push(
      { label: af(locale) ? "Meterlesing" : "Meter reading", value: meter(machine, draft.reading ?? 0) },
      { label: af(locale) ? "Diensdatum" : "Service date", value: draft.serviceDate ?? "" },
      {
        label: af(locale) ? "Diensplan" : "Service schedule",
        value: af(locale)
          ? "Skep ’n voltooide diensrekord; geen geskeduleerde taak word outomaties as gedoen gemerk nie."
          : "Creates a completed service record; no scheduled task is automatically marked done.",
      },
    );
    if (draft.workPerformed) {
      facts.push({ label: af(locale) ? "Werk gedoen" : "Work performed", value: draft.workPerformed });
    }
  }

  return { proposalId: id, title, intent: draft.intent!, machineName: machine.name, facts, expiresAt };
}
