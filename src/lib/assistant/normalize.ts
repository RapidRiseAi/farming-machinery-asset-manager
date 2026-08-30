import type { AssistantMachine } from "./types";

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
    .replace(/[^a-z0-9.'/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(value: string): Set<string> {
  const padded = `  ${normalizeAssistantText(value)}  `;
  const grams = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
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
export function matchMachine(input: string, machines: AssistantMachine[]): MachineMatch {
  const haystack = normalizeAssistantText(input);
  const ranked = machines
    .map((machine) => {
      const labels = [machine.name, machine.make, machine.model, ...machine.aliases]
        .filter((v): v is string => Boolean(v?.trim()))
        .map(normalizeAssistantText);
      let best = 0;
      for (const label of labels) {
        if (!label) continue;
        if (haystack === label) best = Math.max(best, 1);
        else if (haystack.includes(label)) best = Math.max(best, 0.98);
        else {
          const candidateWindows = windows(haystack, label.split(" ").length);
          for (const candidate of candidateWindows) best = Math.max(best, diceSimilarity(candidate, label));
        }
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
