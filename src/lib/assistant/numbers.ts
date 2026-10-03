/**
 * Spoken numbers to digits, in English and Afrikaans: "four thousand three hundred",
 * "nineteen hundred", "drie duisend vier honderd en vyftig", "vyf-en-twintig".
 *
 * Recognisers usually write digits, but not always: some transcribers spell readings
 * out, and people answering "what is the reading?" say the words. Only a run that is
 * clearly a quantity becomes digits (it has a hundred/thousand, a tens word, or is a
 * string of three or more single digits read out one by one), so "the one with the flat
 * tyre" and "een van die trekkers" stay words.
 */

const UNITS: Record<string, number> = {
  zero: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vyf: 5, ses: 6, sewe: 7, agt: 8, nege: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14, vyftien: 15, sestien: 16, sewentien: 17, agtien: 18, negentien: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  twintig: 20, dertig: 30, veertig: 40, vyftig: 50, sestig: 60, sewentig: 70, tagtig: 80, negentig: 90,
};
const MAGNITUDES: Record<string, number> = { hundred: 100, honderd: 100, thousand: 1000, duisend: 1000, million: 1_000_000, miljoen: 1_000_000 };
const CONNECTORS = new Set(["and", "en"]);

/** Afrikaans writes compounds as one word: "twaalfhonderd", "vierduisend", "vyfentwintig". */
function splitCompound(word: string): string[] {
  if (UNITS[word] !== undefined || TEENS[word] !== undefined || TENS[word] !== undefined || MAGNITUDES[word] !== undefined) return [word];
  const parts = word.split(/(honderd|duisend|miljoen|en(?=(?:twintig|dertig|veertig|vyftig|sestig|sewentig|tagtig|negentig)$))/).filter(Boolean);
  return parts.every((part) => UNITS[part] !== undefined || TEENS[part] !== undefined || TENS[part] !== undefined || MAGNITUDES[part] !== undefined || part === "en")
    ? parts
    : [word];
}

const isNumberWord = (word: string) =>
  UNITS[word] !== undefined || TEENS[word] !== undefined || TENS[word] !== undefined || MAGNITUDES[word] !== undefined;

function valueOf(words: string[]): number | null {
  const digitsOnly = words.every((word) => UNITS[word] !== undefined);
  if (digitsOnly) return words.length >= 3 ? Number(words.map((word) => UNITS[word]).join("")) : null;
  let total = 0;
  let current = 0;
  let quantity = false;
  for (const word of words) {
    if (UNITS[word] !== undefined) current += UNITS[word];
    else if (TEENS[word] !== undefined) { current += TEENS[word]; quantity = true; }
    else if (TENS[word] !== undefined) { current += TENS[word]; quantity = true; }
    else if (word === "hundred" || word === "honderd") { current = (current || 1) * 100; quantity = true; }
    else if (MAGNITUDES[word] !== undefined) { total += (current || 1) * MAGNITUDES[word]; current = 0; quantity = true; }
  }
  return quantity ? total + current : null;
}

/** Replace each spoken quantity in already-normalised text with its digits. */
export function replaceNumberWords(text: string): string {
  const tokens = text.split(" ").flatMap((token) => token.split("-")).flatMap(splitCompound).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // A connector at the end of a run belongs to the sentence, not the number.
    const trailing: string[] = [];
    while (run.length && CONNECTORS.has(run[run.length - 1])) trailing.unshift(run.pop()!);
    const value = run.length ? valueOf(run.filter((word) => !CONNECTORS.has(word))) : null;
    if (value !== null) out.push(String(value));
    else out.push(...run);
    out.push(...trailing);
    run = [];
  };
  for (const token of tokens) {
    if (isNumberWord(token) || (run.length && CONNECTORS.has(token))) run.push(token);
    else { flush(); out.push(token); }
  }
  flush();
  return out.join(" ");
}
