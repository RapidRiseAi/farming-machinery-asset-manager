/**
 * How people actually SAY a machine, as opposed to how it is named in the register.
 *
 * Farm talk mixes Afrikaans and English inside one sentence: "what's the status of the
 * rooi bakkie's repairs?". Azure picks ONE language per spoken segment, so a sentence
 * that is mostly English goes through the English model, and "rooi bakkie" comes back
 * as "roy backie". Nothing here makes the transcript perfect; it makes the MACHINE
 * findable, which is the only part of that sentence the assistant has to get right:
 *
 *   - `soundKey` folds a phrase to roughly how it sounds, so "roy backie" and
 *     "rooi bakkie" compare as the same thing;
 *   - `crossLanguageVariants` translates colour and machine-type words, so "the white
 *     bakkie" can find "Wit Toyota Bakkie" and "die rooi trekker" a "Red Tractor";
 *   - `shortSpokenForms` derives the two-word way people refer to a machine
 *     ("rooi bakkie", "red bakkie") from its full name.
 *
 * All three are pure, deterministic and only ever used to RANK machines the signed-in
 * person can already see. A match is a suggestion: a write still goes through the
 * confirmation card, and two equally good matches still make the assistant ask.
 */

/** Afrikaans and English colour words, each group meaning the same colour. */
const COLOUR_GROUPS: readonly (readonly string[])[] = [
  ["rooi", "red"],
  ["wit", "white"],
  ["groen", "green"],
  ["blou", "blue"],
  ["swart", "black"],
  ["geel", "yellow"],
  ["oranje", "orange"],
  ["grys", "grey", "gray"],
  ["bruin", "brown"],
  ["silwer", "silver"],
];

/**
 * Machine-type words. South Africans say "bakkie" in English too, so it stands on its
 * own and also pairs with "pickup". The first word of each group is the one a short
 * spoken form is built from.
 */
const TYPE_GROUPS: readonly (readonly string[])[] = [
  ["bakkie", "pickup", "ute"],
  ["trekker", "tractor"],
  ["stroper", "harvester", "combine"],
  ["vragmotor", "trok", "truck", "lorry"],
  ["sleepwa", "trailer"],
  ["sproeier", "sprayer"],
  ["planter", "planter"],
  ["laaier", "loader"],
  ["voorlaaier", "front loader"],
  ["graafmasjien", "excavator", "digger"],
  ["motorfiets", "motorbike", "bike"],
  ["kar", "car"],
];

/**
 * Words that describe or relate rather than name, said in either language: "Die Ou
 * Massey" is "the old Massey" to an English speaker, "Oom Piet se Trok" is "Uncle Piet's
 * truck". True translations only: a mishearing ("great" for "groot") added here turns
 * "Big Red" into "great red" and makes it tie with "the great tracker". Mishearings are
 * the transcriber's to fix.
 */
const DESCRIPTOR_GROUPS: readonly (readonly string[])[] = [
  ["ou", "old"],
  ["groot", "big"],
  ["klein", "small", "little"],
  ["nuwe", "new"],
  ["oom", "uncle"],
  ["tannie", "aunt"],
  ["die", "the"],
];

/** "X se Y" is the Afrikaans possessive; in English it becomes "X's Y". */
const POSSESSIVE_GROUP: readonly string[] = ["se", "'s"];

/**
 * Words that point or classify rather than name. A label that matches ONLY on these
 * names nothing: "the tractor" must not pick the one machine called "Groot Trekker"
 * out of six tractors. See `distinctiveWords`.
 */
const TYPE_WORDS = new Set<string>(TYPE_GROUPS.flatMap((group) => group.flatMap((word) => word.split(" "))));
const GENERIC_WORDS = new Set<string>([...TYPE_WORDS, "the", "die", "a", "an", "'n", "n", "se", "s", "of", "van"]);

function groupOf(word: string, groups: readonly (readonly string[])[]): readonly string[] | null {
  for (const group of groups) if (group.includes(word)) return group;
  return null;
}

/**
 * The other-language spellings of a phrase: every colour, type or descriptor word
 * swapped for each of its counterparts, one at a time and all together. "wit toyota
 * bakkie" gives "white toyota bakkie" and "white toyota pickup", among others; "oom piet
 * se trok" gives "uncle piet's truck". Capped, so a long name cannot explode into
 * hundreds of variants.
 */
export function crossLanguageVariants(phrase: string, limit = 32): string[] {
  const words = phrase.toLocaleLowerCase("en-ZA").split(/\s+/).filter(Boolean);
  let variants: string[][] = [words];
  for (let i = 0; i < words.length; i += 1) {
    const group = groupOf(words[i], COLOUR_GROUPS)
      ?? groupOf(words[i], TYPE_GROUPS)
      ?? groupOf(words[i], DESCRIPTOR_GROUPS)
      ?? (i > 0 && words[i] === "se" ? POSSESSIVE_GROUP : null);
    if (!group) continue;
    const next: string[][] = [];
    for (const variant of variants) {
      for (const alternative of group) {
        const copy = [...variant];
        copy[i] = alternative;
        next.push(copy);
      }
    }
    variants = next.slice(0, limit * 4);
  }
  // The English possessive belongs to the word before it: "piet 's" is "piet's".
  const join = (variant: string[]) => variant.join(" ").replace(/ 's\b/g, "'s");
  const original = join(words);
  const seen = new Set<string>([original]);
  const result: string[] = [];
  for (const variant of variants) {
    const value = join(variant);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

/** The words of a label that actually identify something: not types, articles or possessives. */
export function distinctiveWords(label: string): string[] {
  return label
    .toLocaleLowerCase("en-ZA")
    .split(/\s+/)
    .map((word) => word.replace(/'s$/, ""))
    .filter((word) => word && !GENERIC_WORDS.has(word));
}

const wordsOf = (phrase: string) =>
  phrase.toLocaleLowerCase("en-ZA").split(/[^a-z0-9'-]+/).filter(Boolean).map((word) => word.replace(/'s$/, ""));

/**
 * Which colours a phrase mentions, as indexes into the colour groups, so "rooi" and
 * "red" count as the same colour. Whole words only: "witkop" is a name, not "wit".
 */
export function coloursIn(phrase: string): Set<number> {
  const words = new Set(wordsOf(phrase));
  const found = new Set<number>();
  COLOUR_GROUPS.forEach((group, index) => {
    if (group.some((colour) => words.has(colour))) found.add(index);
  });
  return found;
}

/**
 * The colours a request uses to DESCRIBE a vehicle: a colour followed within three words
 * by a vehicle word, or by one of `nouns` (the make or model being considered). "the white
 * Toyota bakkie" describes a white bakkie; "white smoke from Ou Blou" describes smoke, and
 * must not count against a blue machine.
 */
export function describedColours(phrase: string, nouns: Iterable<string> = []): Set<number> {
  const words = wordsOf(phrase);
  const vehicle = new Set<string>([...TYPE_WORDS, ...[...nouns].flatMap(wordsOf)]);
  const found = new Set<number>();
  words.forEach((word, index) => {
    const colour = COLOUR_GROUPS.findIndex((group) => group.includes(word));
    if (colour >= 0 && words.slice(index + 1, index + 4).some((next) => vehicle.has(next))) found.add(colour);
  });
  return found;
}

/**
 * The short way a machine is spoken about: a colour and a machine type found in its
 * name, in both languages. "Rooi Toyota Hilux Bakkie" gives "rooi bakkie" and
 * "red bakkie" (and "red pickup"); a name without both a colour and a type gives none,
 * because "the Toyota" is already matched by the name itself.
 */
export function shortSpokenForms(name: string): string[] {
  const words = name.toLocaleLowerCase("en-ZA").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const colour = words.map((word) => groupOf(word, COLOUR_GROUPS)).find(Boolean);
  const type = words.map((word) => groupOf(word, TYPE_GROUPS)).find(Boolean);
  if (!colour || !type) return [];
  const forms: string[] = [];
  for (const c of colour) {
    for (const k of type) {
      const value = `${c} ${k}`;
      if (!forms.includes(value)) forms.push(value);
    }
  }
  return forms;
}

/**
 * Fold a phrase to roughly how it sounds, for Afrikaans spoken and English heard (and
 * the reverse). Applied to BOTH sides of a comparison, so it only has to be consistent,
 * not phonetically exact: "rooi bakkie" and "roy backie" both become "roy baki".
 *
 * Ordered: digraphs before single letters, vowels after consonants, doubles last.
 */
const SOUND_RULES: Array<[RegExp, string]> = [
  [/'s\b/g, ""],
  [/'/g, ""],
  // Afrikaans spellings to what an English ear writes down.
  [/ooi/g, "oy"],
  [/oei/g, "uy"],
  [/aai/g, "ay"],
  [/eeu/g, "eu"],
  [/tj/g, "ch"],
  [/sj/g, "sh"],
  [/dt\b/g, "t"],
  [/ph/g, "f"],
  [/th/g, "t"],
  [/ck/g, "k"],
  [/q/g, "k"],
  [/c(?=[aou]|\b)/g, "k"],
  [/x/g, "ks"],
  [/z/g, "s"],
  // Afrikaans w sounds like an English v, and v like an f.
  [/v/g, "f"],
  [/w/g, "f"],
  // Afrikaans j sounds like an English y; a guttural g is heard as "h".
  [/j/g, "y"],
  [/g/g, "h"],
  // Vowels: the endings bakkie / backy / bucky meet at "i"; long vowels shorten.
  [/(?:ie|ey|ee|y)\b/g, "i"],
  [/oo/g, "o"],
  [/ee/g, "e"],
  [/aa/g, "a"],
  [/uu/g, "u"],
  [/oe/g, "u"],
  [/ie/g, "i"],
  [/u(?=[bcdfghklmnprstfy])/g, "a"],
  // Doubled letters last, after the rules above have produced their own doubles.
  [/([a-z])\1+/g, "$1"],
];

export function soundKey(phrase: string): string {
  let value = phrase.toLocaleLowerCase("en-ZA");
  for (const [pattern, replacement] of SOUND_RULES) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, " ").trim();
}
