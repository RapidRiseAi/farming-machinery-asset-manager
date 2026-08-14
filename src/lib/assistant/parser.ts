import { normalizeAssistantText } from "./normalize";
import { todayInSouthAfrica } from "./date";
import type { AssistantDraft, AssistantIntent, AssistantLocale, AssistantUrgency } from "./types";

const FAULT_WORDS = /\b(problem|fault|issue|leak|leaking|broken|noise|defect|probleem|fout|lek|lekking|gebreek|geraas|defek)\b/;
const READING_WORDS = /\b(reading|hours?|hrs?|engine hours?|odometer|kilomet(?:er|re)s?|km|lesing|ure|enjinure|kilometer)\b/;
const SERVICE_WORDS = /\b(service|serviced|maintenance|diens|gediens|onderhoud)\b/;
const COMPLETED_WORDS = /\b(done|completed|finished|logged|gedoen|voltooi|afgehandel|aangeteken|klaar)\b/;

function extractNumber(text: string): number | null {
  const matches = [...text.matchAll(/\b(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\b/g)];
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1][1];
  const compact = raw.replace(/[ ,](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const value = Number(compact);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function inferIntent(text: string): { intent: AssistantIntent | null; confidence: number } {
  const asks = /\b(when|what|how|is|show|tell|wanneer|wat|hoe|wys|vertel)\b/.test(text) || text.endsWith("?");
  if (SERVICE_WORDS.test(text) && COMPLETED_WORDS.test(text)) {
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
  if (READING_WORDS.test(text) && (/\b(log|record|set|capture|add|aanteken|teken|stel|registreer)\b/.test(text) || extractNumber(text) != null)) {
    return { intent: "log_reading", confidence: 0.9 };
  }
  if (FAULT_WORDS.test(text) || /\b(report|meld|rapporteer)\b/.test(text)) {
    return { intent: "report_fault", confidence: 0.88 };
  }
  return { intent: null, confidence: 0.25 };
}

function inferUrgency(text: string): AssistantUrgency {
  if (/\b(stopped|stop|won't start|cannot work|out of service|gestop|staan stil|wil nie start|kan nie werk)\b/.test(text)) return "stopped";
  if (/\b(limping|limited|still works|reduced|sukkel|werk nog|beperk)\b/.test(text)) return "limping";
  return "can_work";
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
  const reading = intent === "log_reading" || intent === "log_service" ? extractNumber(normalized) : null;

  return {
    intent,
    // The local entity resolver intentionally receives the whole sentence. It tests
    // every visible canonical name and alias against matching word windows.
    machineQuery: normalized || null,
    machineId: null,
    description: intent === "report_fault" ? input.trim() || null : null,
    category: intent === "report_fault" ? inferCategory(normalized) : null,
    urgency: intent === "report_fault" ? inferUrgency(normalized) : null,
    reading,
    readingDate: intent === "log_reading" ? todayInSouthAfrica() : null,
    serviceDate: intent === "log_service" ? todayInSouthAfrica() : null,
    workPerformed: intent === "log_service" ? input.trim() || null : null,
    confidence,
  };
}
