import { normalizeAssistantText } from "./normalize";

/**
 * What a question is about, and whether the free local reads can answer it.
 *
 * The local reads (local-read.ts) answer a fixed set of phrasings for nothing and at once:
 * "show open faults", "which machines need a service". They cannot add anything up, compare
 * machines, look at fuel or money, or follow a period. The founder's rule is to use AI only
 * where it is needed, so a question goes to the AI agent only when it asks for something
 * the local reads cannot do, and keeps the local answer when AI is not available.
 */

export const FARM_TOPICS = ["fuel", "costs", "faults", "jobcards", "service", "work", "documents", "readings"] as const;
export type FarmTopic = (typeof FARM_TOPICS)[number];

const TOPIC_PATTERNS: Record<FarmTopic, RegExp> = {
  fuel: /\b(fuel|fuels|diesel|petrol|litres?|liters?|tank|tanks|bowser|consumption|refuel(?:led|ed)?|filled|brandstof|liter|tenk|tenks|verbruik|ingegooi|volgemaak)\b/,
  costs: /\b(costs?|costing|spend|spent|spending|expenses?|expensive|cheapest|money|rand|price|prices|paid|pay|bill|bills|budget|tco|koste|kos|gekos|kosbaar|spandeer|gespandeer|bestee|uitgawes?|duur|duurste|goedkoopste|geld|prys|pryse|betaal|rekening|begroting)\b/,
  faults: /\b(faults?|problems?|issues?|broken|breakdowns?|leak|leaks|leaking|foute?|probleme?|stukkend|gebreek|onklaar|lek|lekkasie)\b/,
  jobcards: /\b(job\s*cards?|jobcards?|repairs?|repaired|workshop|mechanic|werkkaarte?|herstel|herstelwerk|werkswinkel|meganikus)\b/,
  service: /\b(service|services|serviced|servicing|maintenance|due|overdue|diens|dienste|onderhoud|verskuldig|agterstallig)\b/,
  work: /\b(work\s*requests?|quote\s*requests?|repair\s*requests?|werkversoeke?|kwotasieversoeke?)\b/,
  documents: /\b(quotes?|quotations?|invoices?|kwotasies?|fakture?|faktuur)\b/,
  readings: /\b(hours|hour|reading|readings|meter|odometer|kilomet(?:er|re)s?|km|ure|uur|lesing|lesings)\b/,
};

/** Asking for a sum, a comparison, a rate, a period or a reason: arithmetic over records. */
const ANALYTIC = new RegExp(
  [
    "\\bhow (?:much|many|long|often|far)\\b",
    "\\b(?:total|totals|sum|average|avg|per|each|every|most|least|highest|lowest|biggest|smallest|more|less|compare|comparison|versus|vs|trend|rate|usage|used|use|uses|using)\\b",
    "\\b(?:this|last|previous|next|past) (?:week|month|year|quarter|season|few)\\b",
    "\\b(?:today|yesterday|since|between|from|until|during|monthly|weekly|daily|yearly|annual|ytd)\\b",
    "\\b(?:why|explain|summary|summarise|summarize|overview|report on)\\b",
    "\\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\\b",
    "\\bhoeveel\\b",
    "\\b(?:totaal|som|gemiddeld|gemiddelde|elke|meeste|minste|hoogste|laagste|grootste|kleinste|meer|minder|vergelyk|teenoor|tendens|gebruik|gebruikte)\\b",
    "\\b(?:hierdie|verlede|vorige|volgende) (?:week|maand|jaar|kwartaal|seisoen)\\b",
    "\\b(?:vandag|gister|vanjaar|sedert|tussen|vanaf|tot|gedurende|maandeliks|weekliks|daagliks|jaarliks)\\b",
    "\\b(?:hoekom|waarom|verduidelik|opsomming|oorsig)\\b",
    "\\b(?:januarie|februarie|maart|mei|junie|julie|augustus|oktober|desember)\\b",
  ].join("|"),
);

/** Words that only make sense against an earlier answer: "and the other one?". */
const FOLLOW_UP = /^(?:and|what about|how about|same for|also|en|wat van|hoe van|dieselfde vir|ook)\b|\b(?:it|its|that one|the other one|them|those|dit|daardie een|die ander een|hulle)\b/;

export type QuestionPeriod = { from: string; to: string; label: string };

const MONTHS: Array<[RegExp, number]> = [
  [/\b(?:january|januarie|jan)\b/, 1], [/\b(?:february|februarie|feb)\b/, 2], [/\b(?:march|maart|mar)\b/, 3],
  [/\b(?:april|apr)\b/, 4], [/\b(?:may|mei)\b/, 5], [/\b(?:june|junie|jun)\b/, 6], [/\b(?:july|julie|jul)\b/, 7],
  [/\b(?:august|augustus|aug)\b/, 8], [/\b(?:september|sept|sep)\b/, 9], [/\b(?:october|oktober|oct|okt)\b/, 10],
  [/\b(?:november|nov)\b/, 11], [/\b(?:december|desember|dec|des)\b/, 12],
];

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function lastDay(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * The period a question names, worked out here rather than by the model: "this month",
 * "last month", "in August", "vanjaar", "the last 3 months". The prefetched numbers are
 * then for exactly that period, so "fuel cost per vehicle this month" arrives as this
 * month's figure per vehicle and the model has nothing to infer. Null when no period is
 * named. A month named without a year is the most recent one that has started.
 */
export function questionPeriod(input: string, today: string): QuestionPeriod | null {
  const text = normalizeAssistantText(input);
  const [y, m, d] = today.split("-").map(Number);
  if (/\b(?:today|vandag)\b/.test(text)) return { from: today, to: today, label: "today" };
  if (/\b(?:yesterday|gister)\b/.test(text)) {
    const day = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    return { from: day, to: day, label: "yesterday" };
  }
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  if (/\b(?:this|hierdie) week\b/.test(text)) return { from: iso(y, m, d - weekday), to: today, label: "this week" };
  if (/\b(?:last|previous|verlede|vorige) week\b/.test(text)) {
    return { from: iso(y, m, d - weekday - 7), to: iso(y, m, d - weekday - 1), label: "last week" };
  }
  if (/\b(?:this|hierdie) maand\b|\bthis month\b/.test(text)) return { from: iso(y, m, 1), to: today, label: "this month" };
  if (/\b(?:last|previous|past|verlede|vorige) (?:month|maand)\b/.test(text)) {
    return { from: iso(y, m - 1, 1), to: lastDay(y, m - 1), label: "last month" };
  }
  const recent = text.match(/\b(?:last|past|previous|afgelope|laaste|vorige) (\d{1,2}|two|three|four|six|twelve|twee|drie|vier|ses|twaalf) (?:months|maande)\b/);
  if (recent) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, six: 6, twelve: 12, twee: 2, drie: 3, vier: 4, ses: 6, twaalf: 12 };
    const n = Math.min(36, Math.max(1, Number(recent[1]) || words[recent[1]] || 3));
    return { from: iso(y, m - n + 1, 1), to: today, label: `the last ${n} months` };
  }
  if (/\b(?:this year|vanjaar|hierdie jaar)\b/.test(text)) return { from: iso(y, 1, 1), to: today, label: "this year" };
  if (/\b(?:last|previous|verlede|vorige) (?:year|jaar)\b/.test(text)) {
    return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31), label: "last year" };
  }
  for (const [pattern, month] of MONTHS) {
    if (!pattern.test(text)) continue;
    // "may" is also a verb: only a month with a cue around it ("in may", "may 2026").
    if (month === 5 && !/\b(?:in|during|for|since|gedurende|sedert)\s+(?:may|mei)\b|\b(?:may|mei)\s+\d{4}\b/.test(text)) continue;
    const named = text.match(/\b(20\d{2})\b/);
    const year = named ? Number(named[1]) : month <= m ? y : y - 1;
    const since = /\b(?:since|sedert|from|vanaf)\b/.test(text);
    return since
      ? { from: iso(year, month, 1), to: today, label: `since the start of ${iso(year, month, 1).slice(0, 7)}` }
      : { from: iso(year, month, 1), to: year === y && month === m ? today : lastDay(year, month), label: iso(year, month, 1).slice(0, 7) };
  }
  return null;
}

export function detectFarmTopics(input: string): FarmTopic[] {
  const text = normalizeAssistantText(input);
  const topics = FARM_TOPICS.filter((topic) => TOPIC_PATTERNS[topic].test(text));
  // "R 2 500" or "R2500" names money even with no money word.
  if (!topics.includes("costs") && /(?:^|\s)r\s?\d/i.test(input)) topics.push("costs");
  return topics;
}

/**
 * True when a question asks for more than a local read can give: fuel or money at all, a
 * sum, a comparison, a period, a reason, or a follow-up to the previous answer.
 */
export function questionNeedsAgent(input: string): boolean {
  const text = normalizeAssistantText(input);
  if (!text) return false;
  const topics = detectFarmTopics(input);
  if (topics.includes("fuel") || topics.includes("costs")) return true;
  return ANALYTIC.test(text) || FOLLOW_UP.test(text);
}
