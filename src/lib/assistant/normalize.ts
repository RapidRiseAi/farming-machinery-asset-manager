import type { AssistantMachine } from "./types";
import { coloursIn, crossLanguageVariants, describedColours, distinctiveWords, shortSpokenForms, soundKey } from "./spoken-forms";

/** A sound-alike match is good evidence, but a literal match of the same label wins. */
const SOUND_DISCOUNT = 0.95;
/**
 * A label several machines share (a make, a model) can support a match but must not
 * carry one. Two John Deeres both scored 0.98 on "john deere" and the assistant asked
 * which one, although the request said "6155". Above the threshold, so "the John Deere"
 * on a farm with two still asks between them.
 */
const SHARED_LABEL_CAP = 0.7;
/** The words that identify a label must themselves be heard; see `labelScore`'s caller. */
const DISTINCTIVE_FLOOR = 0.6;
/** A derived spelling ("red bakkie" from "Rooi Bakkie") ranks just below a real name. */
const DERIVED_DISCOUNT = 0.97;

const SPOKEN_NAME_REPLACEMENTS: Array<[RegExp, string]> = [
  // Common single-consonant Afrikaans transcript/spelling variant.
  [/\braporteer\b/g, "rapporteer"],
  [/\b(?:djon|john|jong)\s+(?:deer|deere|deur)\b/g, "john deere"],
  [/\bmacy\s+ferguson\b/g, "massey ferguson"],
  [/\bmer(?:c|s)(?:edes|adies|edis|edys|edez)(?:[ -]+benz)?\b/g, "mercedes benz"],
  [/\bmer\s+say\s+this(?:[ -]+benz)?\b/g, "mercedes benz"],
  // Observed from the af-ZA recognizer when Willem says "Mercedes trok".
  // Keep these contextual to truck/trok so ordinary Afrikaans words are not
  // globally rewritten into a vehicle brand.
  [/\bverkeerdes\s+(trok|truck)\b/g, "mercedes benz $1"],
  [/\bmerk(?:ie|e)?\s+(?:dis|des)\s+(trok|truck)\b/g, "mercedes benz $1"],
  [/\bmerk\s+jy\s+dis\s+(trok|truck)\b/g, "mercedes benz $1"],
  [/\bnew\s+hollandt?\b/g, "new holland"],
];

export function normalizeAssistantText(value: string): string {
  let normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .toLocaleLowerCase("en-ZA");

  for (const [pattern, replacement] of SPOKEN_NAME_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized
    // Azure's Afrikaans model glues the possessive on with a full stop ("oompiet.se
    // trok"), and every recogniser ends a sentence with one ("6155."): neither belongs
    // to a word. A dot between digits stays, for models ("T7.210") and readings.
    .replace(/(?<=[a-z])\.(?=[a-z])/g, " ")
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/[^a-z0-9.'/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Matching compares every label of every machine against every window of the request,
 * so the same short strings are turned into trigrams thousands of times per call (586 ms
 * over 300 machines). These caches are keyed by the exact input string, so they change no
 * score; they are bounded and simply start again when full.
 */
const MEMO_LIMIT = 50_000;
function remember<T>(memo: Map<string, T>, key: string, make: () => T): T {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(key, value);
  return value;
}
const gramMemo = new Map<string, Set<string>>();
const keyMemo = new Map<string, string>();
const soundKeyOf = (value: string) => remember(keyMemo, value, () => soundKey(value));

function trigrams(value: string): Set<string> {
  return remember(gramMemo, value, () => {
    const padded = `  ${normalizeAssistantText(value)}  `;
    const grams = new Set<string>();
    for (let i = 0; i <= padded.length - 3; i += 1) grams.add(padded.slice(i, i + 3));
    return grams;
  });
}

function diceSimilarity(a: string, b: string): number {
  const aa = trigrams(a);
  const bb = trigrams(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let shared = 0;
  for (const gram of aa) if (bb.has(gram)) shared += 1;
  return (2 * shared) / (aa.size + bb.size);
}

function windows(text: string, wordCount: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const sizes = [...new Set([Math.max(1, wordCount - 1), wordCount, wordCount + 1])];
  const result: string[] = [];
  for (const size of sizes) {
    for (let i = 0; i <= words.length - size; i += 1) result.push(words.slice(i, i + size).join(" "));
  }
  return result;
}

export type MachineMatch = {
  machine: AssistantMachine | null;
  score: number;
  ambiguous: boolean;
  alternatives: AssistantMachine[];
};

/**
 * Resolve only against machines already visible through the signed-in user's RLS query.
 * A fuzzy result is a suggestion for confirmation, never an implicit write authority.
 */
/**
 * Every way a machine may be spoken about: its own labels, the same labels with colour
 * and type words in the other language ("wit" for "white", "trekker" for "tractor"),
 * and the short "rooi bakkie" form derived from a name that has both. See
 * `spoken-forms.ts`.
 */
type SpokenLabel = { text: string; derived: boolean };

const labelMemo = new Map<string, SpokenLabel[]>();
function labelsOf(machine: AssistantMachine): SpokenLabel[] {
  const signature = JSON.stringify([machine.name, machine.make, machine.model, machine.aliases]);
  return remember(labelMemo, signature, () => buildLabels(machine));
}

function buildLabels(machine: AssistantMachine): SpokenLabel[] {
  const own = [machine.name, machine.make, machine.model, ...machine.aliases]
    .filter((v): v is string => Boolean(v?.trim()))
    .map(normalizeAssistantText)
    .filter(Boolean);
  const labels = new Map<string, SpokenLabel>();
  for (const text of own) labels.set(text, { text, derived: false });
  const derive = (text: string) => {
    if (text && !labels.has(text)) labels.set(text, { text, derived: true });
  };
  for (const label of own) {
    for (const variant of crossLanguageVariants(label)) derive(normalizeAssistantText(variant));
  }
  for (const label of [machine.name, ...machine.aliases]) {
    for (const form of shortSpokenForms(label)) derive(normalizeAssistantText(form));
  }
  return [...labels.values()];
}

export function spokenLabels(machine: AssistantMachine): string[] {
  return labelsOf(machine).map((label) => label.text);
}

/** How well one label is heard in the normalised request: literally, then by sound. */
function labelScore(label: string, haystack: string, hayKey: string): number {
  let best = 0;
  if (haystack === label) best = 1;
  // A one- or two-character label is a substring of ordinary words, "next" contains
  // "x", so a machine whose model is "X" would score 0.98 against almost any sentence,
  // and two such machines look equally likely to be meant. Short labels still match
  // through trigram similarity below.
  else if (label.length >= 3 && haystack.includes(label)) best = 0.98;
  else {
    for (const candidate of windows(haystack, label.split(" ").length)) best = Math.max(best, diceSimilarity(candidate, label));
  }
  // How it sounds, for a word heard in the other language: "roy backie" for "rooi
  // bakkie". Same short-label guard as above, on the folded form.
  if (best >= 0.98) return best;
  const labelKey = soundKeyOf(label);
  if (labelKey.length >= 4 && hayKey.includes(labelKey)) return Math.max(best, 0.98 * SOUND_DISCOUNT);
  for (const candidate of windows(hayKey, labelKey.split(" ").length)) {
    best = Math.max(best, diceSimilarity(candidate, labelKey) * SOUND_DISCOUNT);
  }
  return best;
}

export function matchMachine(input: string, machines: AssistantMachine[]): MachineMatch {
  const haystack = normalizeAssistantText(input);
  const hayKey = soundKey(haystack);
  const labelled = machines.map((machine) => ({ machine, labels: labelsOf(machine) }));
  const owners = new Map<string, number>();
  for (const { labels } of labelled) {
    for (const label of labels) owners.set(label.text, (owners.get(label.text) ?? 0) + 1);
  }
  const ranked = labelled
    .map(({ machine, labels }) => {
      // "the white bakkie" is not the Rooi Bakkie, however well "bakkie" or "Toyota"
      // matches: a colour the request gives the VEHICLE contradicts the machine's own.
      const own = coloursIn([machine.name, ...machine.aliases].join(" "));
      if (own.size) {
        const described = describedColours(haystack, [machine.make, machine.model].filter((v): v is string => Boolean(v)));
        if (described.size && ![...own].some((colour) => described.has(colour))) return { machine, score: 0 };
      }
      let best = 0;
      for (const label of labels) {
        let score = labelScore(label.text, haystack, hayKey);
        if (score <= 0) continue;
        // A label carried by its type word alone names nothing: "the tractor" must not
        // pick "Groot Trekker" out of six tractors. Its identifying words must be heard.
        const words = label.text.split(" ");
        const distinct = distinctiveWords(label.text);
        if (distinct.length && distinct.length < words.length) {
          const support = labelScore(distinct.join(" "), haystack, hayKey);
          if (support < DISTINCTIVE_FLOOR) score = Math.min(score, support);
        }
        if ((owners.get(label.text) ?? 1) > 1) score = Math.min(score, SHARED_LABEL_CAP);
        if (label.derived) score *= DERIVED_DISCOUNT;
        best = Math.max(best, score);
      }
      return { machine, score: best };
    })
    .sort((a, b) => b.score - a.score);

  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.score < 0.58) {
    return { machine: null, score: first?.score ?? 0, ambiguous: false, alternatives: ranked.slice(0, 5).map((r) => r.machine) };
  }
  const ambiguous = Boolean(second && second.score >= 0.58 && first.score - second.score < 0.12);
  return {
    machine: ambiguous ? null : first.machine,
    score: first.score,
    ambiguous,
    alternatives: ranked.filter((r) => r.score >= Math.max(0.5, first.score - 0.2)).slice(0, 5).map((r) => r.machine),
  };
}
