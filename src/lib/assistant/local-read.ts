import { normalizeAssistantText } from "./normalize";
import {
  canReadFinancialDocuments,
  listDocuments,
  listJobCards,
  listFaults,
  listWorkRequests,
  resolveVisibleMachine,
  type AssistantReadScope,
  type DocumentReadRow,
  type FaultReadRow,
  type JobCardReadRow,
  type MachineResolution,
  type WorkRequestReadRow,
} from "./read-data";
import type {
  AssistantDocumentStatus,
  AssistantLocalReadRequest,
  AssistantLocale,
  AssistantMachine,
  AssistantNavigation,
} from "./types";

export type LocalReadRequest = AssistantLocalReadRequest;
export type { AssistantNavigation } from "./types";

export type LocalReadAnswer = {
  message: string;
  speakText: string;
  navigation: AssistantNavigation;
  machineId?: string;
  machineOptions?: Array<{ id: string; name: string }>;
};

const READ_CUE = /\b(show|list|which|what|where|how many|tell me|see|view|find|check|get|give me|status|overview|summary|current|open|active|recent|unpaid|outstanding|wys|toon|lys|watter|wat|waar|hoeveel|vertel|sien|bekyk|soek|kyk|gee my|status|oorsig|opsomming|huidige|oop|aktiewe|onlangse|onbetaalde|uitstaande)\b/;
const QUESTION_START = /^(?:who|has|have|was|were|do|does|did|is|are|can|could|would|wie|het|was|is|kan|kon|sou)\b/;
const WRITE_CUE = /\b(report|log|record|capture|add|create|make|issue|send|update|edit|delete|remove|close|complete|resolve|accept|decline|pay|meld|rapporteer|teken|aanteken|registreer|voeg|skep|maak|reik|stuur|verander|wysig|verwyder|sluit|voltooi|los op|aanvaar|weier|betaal)\b/;
const UNSUPPORTED_ACTION_CUE = /\b(update|edit|change|correct|delete|remove|close|resolve|fix|repair|mark|cancel|archive|accept|decline|reject|pay|send|email|upload|verander|wysig|korrigeer|verwyder|sluit|los op|maak reg|herstel|merk|kanselleer|argiveer|aanvaar|weier|betaal|stuur|e-pos|oplaai)\b/;
const UNSUPPORTED_STATE_CUE = /\b(resolved|fixed|repaired|closed|cancelled|canceled|archived|deleted|removed|updated|edited|paid|accepted|declined|rejected|opgelos|reggemaak|herstel|gesluit|gekanselleer|geargiveer|verwyder|verander|gewysig|betaal|aanvaar|geweier)\b/;
const TERSE_READ = /^(?:my\s+)?(?:fleet|machines?|assets?|faults?|problems?|job\s*cards?|work\s*requests?|quotes?|quotations?|invoices?|documents?|vloot|masjiene?|bates?|foute?|probleme?|werkkaarte?|werkversoeke?|kwotasies?|fakture?|dokumente?)$/;

function supportedDeterministicWrite(text: string): boolean {
  if (/\b(report|raise|meld|rapporteer)\b/.test(text) && /\b(problem|fault|issue|leak|broken|probleem|fout|lek|gebreek(?:te|de)?)\b/.test(text)) return true;
  if (/\b(log|record|capture|set|aanteken|teken|registreer|stel)\b/.test(text) && /\b(reading|hours?|engine hours?|odometer|kilomet(?:er|re)s?|km|lesing|ure|enjinure|kilometer)\b/.test(text)) return true;
  return /\b(service|maintenance|diens|onderhoud)\b/.test(text) && /\b(done|completed|finished|gedoen|voltooi|afgehandel|klaar)\b/.test(text);
}

function actionNavigation(text: string): AssistantNavigation {
  if (/\b(job\s*cards?|jobcards?|werkkaarte?)\b/.test(text)) return "jobcards";
  if (/\b(work\s*requests?|repair\s*requests?|quote\s*requests?|werkversoeke?|herstelversoeke?|kwotasieversoeke?)\b/.test(text)) return "work";
  if (/\b(quotes?|quotations?|invoices?|documents?|kwotasies?|fakture?|dokumente?)\b/.test(text)) return "documents";
  if (/\b(faults?|problems?|issues?|foute?|probleme?)\b/.test(text)) return "faults";
  if (/\b(machines?|assets?|masjiene?|bates?)\b/.test(text)) return "machines";
  return "none";
}

/**
 * Recognise common read/navigation requests before the command parser. This is
 * deliberately narrow: a possible write is never reinterpreted as a harmless read.
 */
export function parseLocalReadRequest(input: string): LocalReadRequest | null {
  const text = normalizeAssistantText(input);
  if (!text) return null;

  if (/\b(what can you do|how can you help|help me|wat kan jy doen|hoe kan jy help|help my)\b/.test(text)) {
    return { kind: "help" };
  }

  if (
    /\b(?:send|show|get|find|stuur|wys|toon|soek)\b.*\b(?:me|my|vir my)\b.*\b(quote|quotation|kwotasie)\b/.test(text) &&
    !/\b(quote request|quote requests|kwotasieversoek|kwotasieversoeke)\b/.test(text)
  ) {
    return { kind: "financial_documents", machineQuery: input, documentKind: "quote", outstandingOnly: false };
  }

  if (
    /\b(create|make|issue|draft|generate|skep|maak|reik|genereer)\b.*\b(quote|quotation|kwotasie)\b/.test(text) ||
    /\b(request a quote|request quote|ask for a quote|versoek '?n kwotasie|vra vir '?n kwotasie)\b/.test(text)
  ) {
    return { kind: "quote_boundary" };
  }

  const navigationVerb = /^(?:please )?(?:open|go to|take me to|navigate to|maak|gaan na|vat my na)\b/.test(text);
  if (navigationVerb && !/\b(open faults?|oop foute?|open job cards?|oop werkkaarte?)\b/.test(text)) {
    if (/\b(machine|machines|asset|assets|masjien|masjiene|bate|bates)\b/.test(text)) return { kind: "navigation", navigation: "machines" };
    if (/\b(fault|faults|problem|problems|fout|foute|probleem|probleme)\b/.test(text)) return { kind: "navigation", navigation: "faults" };
    if (/\b(job card|job cards|jobcard|jobcards|werkkaart|werkkaarte)\b/.test(text)) return { kind: "navigation", navigation: "jobcards" };
    if (/\b(work request|work requests|repair request|quote request|werkversoek|werkversoeke|herstelversoek|kwotasieversoek)\b/.test(text)) return { kind: "navigation", navigation: "work" };
    if (/\b(quote|quotes|quotation|invoice|invoices|document|documents|kwotasie|kwotasies|faktuur|fakture|dokument|dokumente)\b/.test(text)) return { kind: "navigation", navigation: "documents" };
  }

  const isRead = READ_CUE.test(text) || QUESTION_START.test(text) || TERSE_READ.test(text) || input.trim().endsWith("?");
  // In Afrikaans, lifecycle status reads naturally use the infinitive inside a
  // relative clause ("fakture wat betaal is"). Remove only that subordinate
  // status wording before looking for an action verb; "wys en betaal" remains
  // an unsupported mutation boundary.
  const actionText = isRead
    ? text.replace(/\bwat\s+(?:betaal|aanvaar|herstel|verwyder|verander)\s+is\b/g, "")
    : text;
  // Destructive or lifecycle-changing verbs are never reinterpreted as one of
  // the assistant's three supported, confirmation-gated writes—even if the
  // sentence also contains words such as fault, reading or completed service.
  if (UNSUPPORTED_ACTION_CUE.test(actionText) || (!isRead && UNSUPPORTED_STATE_CUE.test(text))) {
    return { kind: "action_boundary", navigation: actionNavigation(text) };
  }

  // A leading/read-question cue makes this a retrieval request. For example,
  // "What fault did we report?" must not propose a second fault report.
  if (WRITE_CUE.test(text) && !isRead) {
    if (supportedDeterministicWrite(text)) return null;
    return { kind: "action_boundary", navigation: actionNavigation(text) };
  }

  if (!isRead) return null;

  if (/\b(work request|work requests|repair request|repair requests|quote request|quote requests|werkversoek|werkversoeke|herstelversoek|herstelversoeke|kwotasieversoek|kwotasieversoeke)\b/.test(text)) {
    const requestKind = /\b(quote|quotation|kwotasie)\b/.test(text)
      ? "quote"
      : /\b(repair|herstel)\b/.test(text)
        ? "repair"
        : /\b(inspection|inspeksie)\b/.test(text)
          ? "inspection"
          : /\b(parts?|onderdele?)\b/.test(text)
            ? "parts"
            : undefined;
    return {
      kind: "work_requests",
      machineQuery: input,
      requestKind,
      view: /\b(all|history|alles|geskiedenis)\b/.test(text) ? "all" : "active",
      status: /\b(requested|versoek)\b/.test(text)
        ? "requested"
        : /\b(viewed|bekyk)\b/.test(text)
          ? "viewed"
          : /\b(quoted|gekwoteer)\b/.test(text)
            ? "quoted"
            : /\b(accepted|aanvaar(?:de)?)\b/.test(text)
              ? "accepted"
              : /\b(in progress|in_progress|aan die gang)\b/.test(text)
                ? "in_progress"
                : /\b(completed|voltooi(?:de)?)\b/.test(text)
                  ? "completed"
                  : /\b(invoiced|gefaktureer)\b/.test(text)
                    ? "invoiced"
                    : /\b(closed|gesluit(?:e)?)\b/.test(text)
                      ? "closed"
                      : undefined,
    };
  }

  if (
    /\b(service|services|maintenance|diens|dienste|onderhoud)\b/.test(text) &&
    /\b(history|completed|done|past|previous|last|geskiedenis|voltooi(?:de)?|gedoen|vorige|laaste)\b/.test(text)
  ) {
    return {
      kind: "job_cards",
      machineQuery: input,
      view: "completed",
      jobType: "scheduled_service",
    };
  }

  if (/\b(job card|job cards|jobcard|jobcards|jobs|werkkaart|werkkaarte)\b/.test(text)) {
    return {
      kind: "job_cards",
      machineQuery: input,
      view: /\b(all|history|recent|alles|geskiedenis|onlangse)\b/.test(text)
        ? "all"
        : /\b(completed|approved|voltooi(?:de)?|goedgekeur(?:de)?)\b/.test(text)
          ? "completed"
          : "active",
    };
  }

  if (/\b(fault|faults|problem|problems|issue|issues|fout|foute|probleem|probleme)\b/.test(text)) {
    const view = /\b(resolved|fixed|closed|opgelos|reggemaak|gesluit)\b/.test(text)
      ? "resolved"
      : /\b(all|history|alles|geskiedenis)\b/.test(text)
        ? "all"
        : "open";
    return { kind: "faults", machineQuery: input, view };
  }

  if (/\b(quote|quotes|quotation|invoice|invoices|document|documents|kwotasie|kwotasies|faktuur|fakture|dokument|dokumente)\b/.test(text)) {
    const documentKind = /\b(invoice|invoices|faktuur|fakture)\b/.test(text)
      ? "invoice"
      : /\b(quote|quotes|quotation|kwotasie|kwotasies)\b/.test(text)
        ? "quote"
        : undefined;
    const status: AssistantDocumentStatus | undefined = /\b(part paid|partially paid|gedeeltelik betaal(?:de)?)\b/.test(text)
        ? "part_paid"
        : /\b(written off|afgeskryf)\b/.test(text)
          ? "written_off"
          : /\b(void|voided|nietig)\b/.test(text)
            ? "void"
            : /\b(paid|betaal(?:de)?)\b/.test(text)
          ? "paid"
          : /\b(accepted|aanvaar(?:de)?)\b/.test(text)
            ? "accepted"
            : /\b(declined|rejected|geweier(?:de)?)\b/.test(text)
              ? "declined"
              : /\b(cancelled|canceled|gekanselleer(?:de)?)\b/.test(text)
                ? "cancelled"
                : /\b(expired|verval(?:le)?)\b/.test(text)
                ? "expired"
                : /\b(sent|gestuur(?:de)?)\b/.test(text)
                  ? "sent"
                  : /\b(draft|konsep)\b/.test(text)
                    ? "draft"
                    : undefined;
    return {
      kind: "financial_documents",
      machineQuery: input,
      documentKind,
      status,
      outstandingOnly: /\b(unpaid|outstanding|onbetaalde|uitstaande)\b/.test(text),
    };
  }

  if (
    /\b(service|services|diens|dienste)\b/.test(text) &&
    /\b(machine|machines|asset|assets|fleet|masjien|masjiene|bate|bates|vloot|due|overdue|verskuldig|agterstallig)\b/.test(text)
  ) {
    return { kind: "service_attention", machineQuery: input };
  }

  if (/\b(fleet|machines|assets|vloot|masjiene|bates)\b/.test(text)) {
    return { kind: "fleet_overview", machineQuery: input };
  }

  return null;
}

function localized(locale: AssistantLocale, english: string, afrikaans: string): string {
  return locale === "af-ZA" ? afrikaans : english;
}

function value(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() ? value.replaceAll("_", " ") : fallback;
}

const AFRIKAANS_STATUS: Record<string, string> = {
  open: "oop",
  acknowledged: "erken",
  in_progress: "aan die gang",
  in_job: "in werkkaart",
  scheduled: "geskeduleer",
  reported: "aangemeld",
  waiting_parts: "wag vir onderdele",
  completed: "voltooi",
  approved: "goedgekeur",
  requested: "versoek",
  viewed: "bekyk",
  quoted: "gekwoteer",
  accepted: "aanvaar",
  invoiced: "gefaktureer",
  closed: "gesluit",
  sent: "gestuur",
  declined: "geweier",
  part_paid: "gedeeltelik betaal",
  paid: "betaal",
  cancelled: "gekanselleer",
  expired: "verval",
  void: "nietig",
  written_off: "afgeskryf",
};

function statusLabel(input: unknown, locale: AssistantLocale): string {
  const raw = value(input);
  return locale === "af-ZA" ? (AFRIKAANS_STATUS[raw.replaceAll(" ", "_")] ?? raw) : raw;
}

function amount(cents: number | null, locale: AssistantLocale): string | null {
  if (cents == null) return null;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "ZAR", maximumFractionDigits: 2 }).format(cents / 100);
}

function hasExplicitMachineQualifier(input: string, kind: LocalReadRequest["kind"]): boolean {
  const text = normalizeAssistantText(input);
  const match = text.match(/\b(?:on|for|of|about|with|op|vir|van|oor|met)\s+(?:(?:the|die|my|'?n)\s+)?([^?.!,]+)\s*$/);
  if (!match) return false;
  const tail = match[1].trim();
  if (!tail || /^(?:all|my|the|die)?\s*(?:fleet|machines?|assets?|service|services|faults?|job\s*cards?|work\s*requests?|quotes?|invoices?|documents?|vloot|masjiene?|bates?|diens|dienste|foute?|werkkaarte?|werkversoeke?|kwotasies?|fakture?|dokumente?)$/.test(tail)) {
    return false;
  }
  if (kind === "financial_documents" && /^(?:inv|quo|invoice|quote|faktuur|kwotasie)[ -]?\d/i.test(tail)) {
    return false;
  }
  return true;
}

const GENERIC_LEADING_FILTERS = new Set([
  "all", "my", "the", "die", "se", "open", "active", "recent", "resolved", "fixed",
  "completed", "approved", "unpaid", "outstanding", "paid", "accepted", "declined",
  "cancelled", "canceled", "expired", "void", "written", "off", "service", "scheduled",
  "repair", "inspection", "parts", "quote", "invoice", "history", "status", "current",
  "alles", "oop", "aktiewe", "onlangse", "opgeloste", "reggemaakte", "voltooide",
  "goedgekeurde", "onbetaalde", "uitstaande", "betaalde", "aanvaarde", "geweierde",
  "gekanselleerde", "vervalle", "nietige", "afgeskryfde", "diens", "geskeduleerde",
  "herstel", "inspeksie", "onderdele", "kwotasie", "faktuur", "geskiedenis", "huidige",
]);

function hasLeadingMachineQualifier(input: string): boolean {
  const text = normalizeAssistantText(input);
  const match = text.match(
    /^(?:please\s+|asseblief\s+)?(?:show|list|find|check|get|give me|wys|toon|lys|soek|kyk|gee my)\s+(?:(?:me|vir my)\s+)?(.+?)\s+(?:se\s+)?(?:service\s+history|diensgeskiedenis|faults?|problems?|issues?|job\s*cards?|jobcards?|work\s*requests?|repair\s*requests?|quote\s*requests?|quotes?|quotations?|invoices?|documents?|foute?|probleme?|werkkaarte?|werkversoeke?|herstelversoeke?|kwotasieversoeke?|kwotasies?|fakture?|dokumente?)\b/,
  );
  if (!match?.[1]) return false;
  const tokens = match[1].split(/\s+/).filter(Boolean);
  return tokens.some((token) => !GENERIC_LEADING_FILTERS.has(token));
}

function localMachineQuery(request: LocalReadRequest, machines: AssistantMachine[]): string | undefined {
  if (!("machineQuery" in request)) return undefined;
  const match = resolveVisibleMachine(request.machineQuery, machines);
  if (match?.ok || match?.reason === "ambiguous") return request.machineQuery;
  return hasExplicitMachineQualifier(request.machineQuery, request.kind) || hasLeadingMachineQualifier(request.machineQuery)
    ? request.machineQuery
    : undefined;
}

function resolutionAnswer(
  match: MachineResolution | undefined,
  machines: AssistantMachine[],
  locale: AssistantLocale,
  navigation: AssistantNavigation,
): LocalReadAnswer | null {
  if (!match || match.ok) return null;
  if (match.reason === "not_found") {
    const message = localized(
      locale,
      "I could not find that machine in the fleet you can access. Please use its full name or alias.",
      "Ek kon nie daardie masjien in die vloot waartoe jy toegang het vind nie. Gebruik asseblief sy volle naam of alias.",
    );
    return { message, speakText: message, navigation: "machines" };
  }
  const options = match.alternatives
    .map((name) => machines.find((machine) => machine.name === name))
    .filter((machine): machine is AssistantMachine => Boolean(machine))
    .map((machine) => ({ id: machine.id, name: machine.name }));
  const names = options.map((machine) => machine.name).join(", ");
  const message = localized(
    locale,
    `I found more than one possible machine: ${names}. Which machine do you mean?`,
    `Ek het meer as een moontlike masjien gevind: ${names}. Watter masjien bedoel jy?`,
  );
  return { message, speakText: message, navigation, machineOptions: options };
}

function boundedList(items: string[], locale: AssistantLocale): string {
  const visible = items.slice(0, 5);
  const suffix = items.length > 5
    ? localized(locale, " More results are available on the linked page.", " Meer resultate is op die gekoppelde blad beskikbaar.")
    : "";
  return `${visible.join("; ")}.${suffix}`;
}

function boundedCount(count: number, englishNoun: string, afrikaansNoun: string, locale: AssistantLocale): string {
  if (count > 5) {
    return localized(locale, `At least ${count} ${englishNoun}`, `Minstens ${count} ${afrikaansNoun}`);
  }
  return localized(locale, `${count} ${englishNoun}`, `${count} ${afrikaansNoun}`);
}

export function formatFleetOverview(machines: AssistantMachine[], locale: AssistantLocale): string {
  const active = machines.filter((machine) => machine.status === "active").length;
  const workshop = machines.filter((machine) => machine.status === "in_workshop").length;
  const overdue = machines.filter((machine) => machine.serviceStatus === "overdue").length;
  const dueSoon = machines.filter((machine) => machine.serviceStatus === "due_soon").length;
  return localized(
    locale,
    `You can access ${machines.length} machines: ${active} active, ${workshop} in the workshop, ${overdue} overdue for service and ${dueSoon} due soon.`,
    `Jy het toegang tot ${machines.length} masjiene: ${active} aktief, ${workshop} in die werkswinkel, ${overdue} agterstallig vir diens en ${dueSoon} binnekort verskuldig.`,
  );
}

export function formatServiceAttention(machines: AssistantMachine[], locale: AssistantLocale): string {
  const attention = machines.filter((machine) => machine.serviceStatus === "overdue" || machine.serviceStatus === "due_soon");
  if (!attention.length) {
    return localized(locale, "No visible machines are overdue or due soon for service.", "Geen sigbare masjiene is agterstallig of binnekort verskuldig vir diens nie.");
  }
  const rows = attention.map((machine) => {
    const status = machine.serviceStatus === "overdue"
      ? localized(locale, "overdue", "agterstallig")
      : localized(locale, "due soon", "binnekort verskuldig");
    const due = machine.nextDueReading != null
      ? `${machine.nextDueReading} ${machine.meterType === "hours" ? localized(locale, "hours", "ure") : "km"}`
      : machine.nextDueDate;
    return `${machine.name}: ${status}${due ? ` (${due})` : ""}`;
  });
  return `${localized(locale, `${attention.length} machines need service attention`, `${attention.length} masjiene benodig diensaandag`)}. ${boundedList(rows, locale)}`;
}

export function formatFaults(
  rows: FaultReadRow[],
  locale: AssistantLocale,
  view: "open" | "resolved" | "all" = "open",
): string {
  const labels = view === "resolved"
    ? ["resolved faults", "opgeloste foute"] as const
    : view === "all"
      ? ["fault records", "foutrekords"] as const
      : ["open faults", "oop foute"] as const;
  if (!rows.length) return localized(locale, `There are no matching ${labels[0]}.`, `Daar is geen ooreenstemmende ${labels[1]} nie.`);
  const items = rows.map((row) => `${row.machine}: ${row.description ?? row.category ?? localized(locale, "fault", "fout")} (${statusLabel(row.status, locale)})`);
  return `${boundedCount(rows.length, labels[0], labels[1], locale)}. ${boundedList(items, locale)}`;
}

export function formatJobCards(
  rows: JobCardReadRow[],
  locale: AssistantLocale,
  view: "active" | "completed" | "all" = "active",
): string {
  const nouns = view === "completed"
    ? ["completed job cards", "voltooide werkkaarte"] as const
    : view === "all"
      ? ["job cards", "werkkaarte"] as const
      : ["active job cards", "aktiewe werkkaarte"] as const;
  if (!rows.length) return localized(locale, `There are no matching ${nouns[0]}.`, `Daar is geen ooreenstemmende ${nouns[1]} nie.`);
  const items = rows.map((row) => {
    const total = amount(row.totalCents, locale);
    const date = typeof row.dateOut === "string" && row.dateOut
      ? row.dateOut
      : typeof row.dateIn === "string" && row.dateIn
        ? row.dateIn
        : null;
    const detail = row.workPerformed ?? row.problem;
    return `${row.machine}: ${statusLabel(row.status, locale)}${date ? ` — ${date}` : ""}${detail ? ` — ${detail}` : ""}${total ? ` — ${total}` : ""}`;
  });
  return `${boundedCount(rows.length, nouns[0], nouns[1], locale)}. ${boundedList(items, locale)}`;
}

export function formatWorkRequests(rows: WorkRequestReadRow[], locale: AssistantLocale): string {
  if (!rows.length) return localized(locale, "There are no matching work requests.", "Daar is geen ooreenstemmende werkversoeke nie.");
  const items = rows.map((row) => {
    const total = amount(row.invoiceAmountCents ?? row.quoteAmountCents, locale);
    return `${row.machine}: ${row.title ?? value(row.kind, localized(locale, "work request", "werkversoek"))} (${statusLabel(row.status, locale)})${total ? ` — ${total}` : ""}`;
  });
  return `${boundedCount(rows.length, "matching work requests", "ooreenstemmende werkversoeke", locale)}. ${boundedList(items, locale)}`;
}

export function formatDocuments(rows: DocumentReadRow[], locale: AssistantLocale, outstandingOnly = false): string {
  if (!rows.length) return localized(locale, "There are no matching quotes or invoices.", "Daar is geen ooreenstemmende kwotasies of fakture nie.");
  const items = rows.map((row) => {
    const total = amount(outstandingOnly ? row.outstandingCents : row.totalCents, locale);
    const label = row.number ?? row.subject ?? value(row.kind, localized(locale, "document", "dokument"));
    return `${label}: ${statusLabel(row.status, locale)}${row.machine ? ` — ${row.machine}` : ""}${total ? ` — ${total}` : ""}`;
  });
  return `${boundedCount(rows.length, "matching documents", "ooreenstemmende dokumente", locale)}. ${boundedList(items, locale)}`;
}

export async function answerLocalRead(
  request: LocalReadRequest,
  scope: AssistantReadScope,
  locale: AssistantLocale,
): Promise<LocalReadAnswer> {
  if (request.kind === "help") {
    const financial = canReadFinancialDocuments(scope.role)
      ? localized(locale, ", quotes and invoices", ", kwotasies en fakture")
      : "";
    const message = localized(
      locale,
      `I can report faults, log readings and completed services, answer machine and service questions, and retrieve visible faults, job cards and work requests${financial}. Changes always require your confirmation.`,
      `Ek kan foute aanmeld, lesings en voltooide dienste aanteken, masjien- en diensvrae beantwoord, en sigbare foute, werkkaarte en werkversoeke${financial} ophaal. Veranderinge vereis altyd jou bevestiging.`,
    );
    return { message, speakText: message, navigation: "none" };
  }

  if (request.kind === "quote_boundary") {
    const message = localized(
      locale,
      "The farm assistant cannot issue a workshop quote. You can create a quote request in Work requests; the linked workshop can then prepare and send the actual quote.",
      "Die plaasassistent kan nie 'n werkswinkelkwotasie uitreik nie. Jy kan 'n kwotasieversoek by Werkversoeke skep; die gekoppelde werkswinkel kan dan die werklike kwotasie opstel en stuur.",
    );
    return { message, speakText: message, navigation: "work" };
  }

  if (request.kind === "action_boundary") {
    const destinations = {
      machines: ["Machines", "Masjiene"],
      faults: ["Faults", "Foute"],
      jobcards: ["Job cards", "Werkkaarte"],
      work: ["Work requests", "Werkversoeke"],
      documents: ["Quotes and invoices", "Kwotasies en fakture"],
      none: ["the relevant page", "die toepaslike blad"],
    } as const;
    const destination = destinations[request.navigation];
    const blockedDocuments = request.navigation === "documents" && !canReadFinancialDocuments(scope.role);
    const message = blockedDocuments
      ? localized(locale, "Your role cannot manage quotes or invoices.", "Jou rol mag nie kwotasies of fakture bestuur nie.")
      : localized(
          locale,
          `That change is not available through the voice assistant yet. Open ${destination[0]} to do it safely.`,
          `Daardie verandering is nog nie deur die stemassistent beskikbaar nie. Maak ${destination[1]} oop om dit veilig te doen.`,
        );
    return {
      message,
      speakText: message,
      navigation: blockedDocuments ? "none" : request.navigation,
    };
  }

  if (request.kind === "navigation") {
    const labels = {
      machines: ["Opening machines.", "Ek maak masjiene oop."],
      faults: ["Opening faults.", "Ek maak foute oop."],
      jobcards: ["Opening job cards.", "Ek maak werkkaarte oop."],
      work: ["Opening work requests.", "Ek maak werkversoeke oop."],
      documents: ["Opening quotes and invoices.", "Ek maak kwotasies en fakture oop."],
    } as const;
    if (request.navigation === "documents" && !canReadFinancialDocuments(scope.role)) {
      const message = localized(locale, "Your role cannot view quotes or invoices.", "Jou rol mag nie kwotasies of fakture sien nie.");
      return { message, speakText: message, navigation: "none" };
    }
    const pair = labels[request.navigation];
    const message = localized(locale, pair[0], pair[1]);
    return { message, speakText: message, navigation: request.navigation };
  }

  if (request.kind === "fleet_overview" || request.kind === "service_attention") {
    const filter = localMachineQuery(request, scope.machines);
    const match = filter ? resolveVisibleMachine(filter, scope.machines) : null;
    const unresolved = resolutionAnswer(match ?? undefined, scope.machines, locale, "machines");
    if (unresolved) return unresolved;
    const selected = match?.ok ? [match.machine] : scope.machines;
    const message = request.kind === "fleet_overview"
      ? formatFleetOverview(selected, locale)
      : formatServiceAttention(selected, locale);
    return {
      message,
      speakText: message,
      navigation: "machines",
      machineId: match?.ok ? match.machine.id : undefined,
    };
  }

  if (request.kind === "faults") {
    const result = await listFaults(scope, {
      machine: localMachineQuery(request, scope.machines),
      view: request.view,
      limit: 6,
    });
    const unresolved = resolutionAnswer(result.match, scope.machines, locale, "faults");
    if (unresolved) return unresolved;
    const message = formatFaults(result.faults, locale, request.view);
    return { message, speakText: message, navigation: "faults", machineId: result.match?.ok ? result.match.machine.id : undefined };
  }

  if (request.kind === "job_cards") {
    const result = await listJobCards(scope, {
      machine: localMachineQuery(request, scope.machines),
      view: request.view,
      type: request.jobType,
      limit: 6,
    });
    const unresolved = resolutionAnswer(result.match, scope.machines, locale, "jobcards");
    if (unresolved) return unresolved;
    const message = formatJobCards(result.jobCards, locale, request.view);
    return { message, speakText: message, navigation: "jobcards", machineId: result.match?.ok ? result.match.machine.id : undefined };
  }

  if (request.kind === "work_requests") {
    const result = await listWorkRequests(scope, {
      machine: localMachineQuery(request, scope.machines),
      kind: request.requestKind,
      view: request.view,
      status: request.status,
      limit: 6,
    });
    const unresolved = resolutionAnswer(result.match, scope.machines, locale, "work");
    if (unresolved) return unresolved;
    const message = formatWorkRequests(result.workRequests, locale);
    return { message, speakText: message, navigation: "work", machineId: result.match?.ok ? result.match.machine.id : undefined };
  }

  const result = await listDocuments(scope, {
    machine: localMachineQuery(request, scope.machines),
    kind: request.documentKind,
    status: request.status,
    outstandingOnly: request.outstandingOnly,
    limit: 6,
  });
  if (result.access === "forbidden_for_role") {
    const message = localized(locale, "Your role cannot view quotes or invoices.", "Jou rol mag nie kwotasies of fakture sien nie.");
    return { message, speakText: message, navigation: "none" };
  }
  const unresolved = resolutionAnswer(result.match, scope.machines, locale, "documents");
  if (unresolved) return unresolved;
  const message = formatDocuments(result.documents, locale, request.outstandingOnly);
  return { message, speakText: message, navigation: "documents", machineId: result.match?.ok ? result.match.machine.id : undefined };
}

export function isLocalReadRequest(value: unknown): value is LocalReadRequest {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  return [
    "help",
    "quote_boundary",
    "action_boundary",
    "navigation",
    "fleet_overview",
    "service_attention",
    "faults",
    "job_cards",
    "work_requests",
    "financial_documents",
  ].includes(String((value as { kind: unknown }).kind));
}
