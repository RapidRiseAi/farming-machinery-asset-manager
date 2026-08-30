import { normalizeAssistantText } from "./normalize";
import { todayInSouthAfrica } from "./date";
import type { AssistantDraft, AssistantIntent, AssistantLocale, AssistantUrgency } from "./types";

const FAULT_WORDS = /\b(problem|fault|issue|leak|leaking|broken|noise|defect|probleem|fout|lek|lekking|gebreek|geraas|defek)\b/;
const READING_WORDS = /\b(reading|hours?|hrs?|engine hours?|odometer|kilomet(?:er|re)s?|km|lesing|ure|enjinure|kilometer)\b/;
const SERVICE_WORDS = /\b(service|serviced|maintenance|diens|gediens|onderhoud)\b/;
const COMPLETED_WORDS = /\b(done|completed|finished|logged|gedoen|voltooi|afgehandel|aangeteken|klaar)\b/;

const NUMBER_SOURCE = String.raw`\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?`;
const MEASUREMENT_UNIT_SOURCE = String.raw`(?:engine\s+hours?|hours?|hrs?|enjinure|ure|kilomet(?:er|re)s?|kilometer|km)`;
const METER_LABEL_SOURCE = String.raw`(?:odometer|meter\s+reading|reading|lesing)`;

function parseMeterNumber(raw: string): number | null {
  const compact = raw
    .replace(/[ ,.](?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const value = Number(compact);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Prefer a number that is explicitly tied to a meter unit or reading marker.
 * A machine model often appears after the real reading (for example Actros
 * 2645), so blindly taking the final numeric token can propose the model as the
 * odometer value.
 */
function extractMeterReading(text: string): number | null {
  const candidates: Array<{ index: number; priority: number; raw: string }> = [];
  const patterns: Array<{ priority: number; expression: RegExp }> = [
    {
      priority: 3,
      expression: new RegExp(
        String.raw`\b(?:at|by|teen|reading(?:\s+is)?|meter\s+reading(?:\s+is)?|odometer(?:\s+is)?|lesing(?:\s+is)?)\s+(${NUMBER_SOURCE})\b`,
        "g",
      ),
    },
    {
      priority: 3,
      expression: new RegExp(
        String.raw`\b(?:completed|done|finished|voltooi|klaar|afgehandel)\s+(?:at\s+|by\s+)?(${NUMBER_SOURCE})\b`,
        "g",
      ),
    },
    {
      priority: 3,
      expression: new RegExp(
        String.raw`\b(?:log|record|capture|aanteken|teken|registreer)\s+(?:the\s+|die\s+)?(${NUMBER_SOURCE})\s+${METER_LABEL_SOURCE}\b`,
        "g",
      ),
    },
    {
      priority: 2,
      expression: new RegExp(String.raw`\b(${NUMBER_SOURCE})\s*(?:-\s*)?${MEASUREMENT_UNIT_SOURCE}\b`, "g"),
    },
    {
      priority: 2,
      expression: new RegExp(String.raw`\b(?:${MEASUREMENT_UNIT_SOURCE}|${METER_LABEL_SOURCE})\s*(?:is\s+|of\s+|van\s+)?(${NUMBER_SOURCE})\b`, "g"),
    },
  ];

  for (const { priority, expression } of patterns) {
    for (const match of text.matchAll(expression)) {
      if (match[1]) candidates.push({ index: match.index, priority, raw: match[1] });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || b.index - a.index);
  return candidates.length ? parseMeterNumber(candidates[0].raw) : null;
}

function inferIntent(text: string): { intent: AssistantIntent | null; confidence: number } {
  const questionStart = /^(?:who|has|have|was|were|do|does|did|is|are|can|could|would|wie|het|was|is|kan|kon|sou)\b/.test(text);
  const asks = questionStart || /\b(when|what|how|is|show|tell|wanneer|wat|hoe|wys|vertel)\b/.test(text) || text.endsWith("?");
  const explicitRead = questionStart || /\b(show|list|which|what|when|tell me|see|view|history|current|wys|toon|lys|watter|wat|wanneer|vertel|sien|bekyk|geskiedenis|huidige)\b/.test(text) || text.endsWith("?");
  const readingWrite = /\b(log|record|set|capture|add|aanteken|teken|stel|registreer|voeg)\b/.test(text);
  if (SERVICE_WORDS.test(text) && COMPLETED_WORDS.test(text)) {
    // A question about completed service history is a read, never a new service entry.
    // The local read router handles common forms without using an AI provider.
    if (explicitRead) return { intent: null, confidence: 0.85 };
    return { intent: "log_service", confidence: 0.94 };
  }
  if (
    SERVICE_WORDS.test(text) &&
    (asks || /\b(due|next|overdue|soon|verskuldig|volgende|agterstallig)\b/.test(text)) &&
    !COMPLETED_WORDS.test(text)
  ) {
    return { intent: "query_service_due", confidence: 0.92 };
  }
  if (/\bstatus\b/.test(text) || /\b(how is|wat is die toestand|is .* active|is .* aktief)\b/.test(text)) {
    return { intent: "query_asset_status", confidence: 0.9 };
  }
  if (READING_WORDS.test(text) && explicitRead) {
    return { intent: "query_asset_status", confidence: 0.92 };
  }
  if (READING_WORDS.test(text) && (readingWrite || extractMeterReading(text) != null)) {
    return { intent: "log_reading", confidence: 0.9 };
  }
  if (FAULT_WORDS.test(text) && explicitRead) return { intent: null, confidence: 0.85 };
  if (FAULT_WORDS.test(text) || /\b(report|meld|rapporteer)\b/.test(text)) {
    return { intent: "report_fault", confidence: 0.88 };
  }
  return { intent: null, confidence: 0.25 };
}

function inferUrgency(text: string): AssistantUrgency | null {
  if (/\b(stopped|stop|won't start|cannot work|out of service|gestop|staan stil|wil nie start|kan nie werk)\b/.test(text)) return "stopped";
  if (/\b(limping|limited|reduced|sukkel|beperk)\b/.test(text)) return "limping";
  if (/\b(can still (?:work|operate)|still works?|safe to use|kan nog werk|werk nog|kan steeds werk)\b/.test(text)) return "can_work";
  return null;
}

/**
 * Remove request scaffolding while preserving the actual symptom in the
 * user's own words. "Report a problem" is an intent, not a fault description.
 */
function extractFaultDescription(input: string): string | null {
  let value = input.trim().replace(/[.!?]+$/u, "").trim();
  if (!value) return null;

  value = value
    .replace(/^\s*(?:please\s+)?(?:i\s+(?:want|would like|need)\s+to\s+)?(?:report|log|record|raise)\s+/iu, "")
    .replace(/^\s*(?:asseblief\s+)?(?:ek\s+wil(?:\s+graag)?\s+)?(?:rap?porteer|meld|raport)\s+/iu, "")
    .trim();

  // Afrikaans commonly places the action verb at the end.
  value = value
    .replace(/^\s*ek\s+wil(?:\s+graag)?\s+/iu, "")
    .replace(/\s+(?:rap?porteer|aanmeld|meld)\s*$/iu, "")
    .trim();

  const normalized = normalizeAssistantText(value)
    .replace(/^(?:a|an|the|'?n|die)\s+/, "")
    .trim();

  // What follows the preposition is normally only the machine reference.
  // Asking again is safer than saving "problem on the Mercedes truck" as if
  // it explained what is broken.
  if (/^(?:problem|fault|issue|probleem|fout)(?:\s+(?:on|with|for|at|op|aan|by|vir)\b.*)?$/.test(normalized)) {
    return null;
  }

  return value || null;
}

function inferCategory(text: string): string | null {
  if (/\b(hydraulic|hydraulics|hidrouliese?|hidroliese?)\b/.test(text)) return "hydraulics";
  if (/\b(electric|electrical|battery|alternator|elektries|battery)\b/.test(text)) return "electrical";
  if (/\b(engine|motor|enjin)\b/.test(text)) return "engine";
  if (/\b(tyre|tire|wheel|band|wiel)\b/.test(text)) return "tyres";
  if (/\b(transmission|gearbox|ratkas|versnelling)\b/.test(text)) return "transmission";
  return null;
}

export function parseDeterministic(input: string, _locale: AssistantLocale): AssistantDraft {
  const normalized = normalizeAssistantText(input);
  const { intent, confidence } = inferIntent(normalized);
  const reading = intent === "log_reading" || intent === "log_service" ? extractMeterReading(normalized) : null;

  return {
    intent,
    // The local entity resolver intentionally receives the whole sentence. It tests
    // every visible canonical name and alias against matching word windows.
    machineQuery: normalized || null,
    machineId: null,
    description: intent === "report_fault" ? extractFaultDescription(input) : null,
    category: intent === "report_fault" ? inferCategory(normalized) : null,
    urgency: intent === "report_fault" ? inferUrgency(normalized) : null,
    reading,
    readingDate: intent === "log_reading" ? todayInSouthAfrica() : null,
    serviceDate: intent === "log_service" ? todayInSouthAfrica() : null,
    workPerformed: intent === "log_service" ? input.trim() || null : null,
    confidence,
  };
}
