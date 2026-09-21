/**
 * Take the em dashes out of everything a person can see, and out of the source too.
 *
 * An em dash used as a parenthetical is the single strongest "written by a machine" tell
 * in this codebase, and the product is sold to farmers who are deciding whether to trust
 * it with their card number. This rewrites the punctuation rather than deleting it: a
 * sentence that used a dash to join two thoughts becomes two sentences, a colon, or a
 * comma, whichever the two halves actually call for.
 *
 * Run with `--apply` to write. Without it, prints what it would do.
 *
 *   node scripts/dash_sweep.mjs            # report
 *   node scripts/dash_sweep.mjs --apply    # rewrite
 *   node scripts/dash_sweep.mjs --copy     # only the two i18n dictionaries
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const COPY_ONLY = process.argv.includes("--copy");

const EM = "—";
const EN = "–";
const BOX = "─";
/** The rest of the box-drawing set. A run of ─ next to any of these is a TABLE, not a banner. */
const TABLE_CHARS = /[┌┐└┘├┤┬┴┼│]/;

// ── Prose rules ─────────────────────────────────────────────────────────────

/**
 * Words that start a new independent clause often enough to justify a full stop.
 *
 * Both languages, because the dictionaries are both being rewritten and an Afrikaans
 * comma splice is just as sloppy as an English one. The imperatives matter most: a farm
 * screen is mostly instructions, and "making a noise, press one button" is the shape this
 * list exists to catch.
 */
const CLAUSE_STARTERS = new Set([
  // English pronouns and determiners
  "you", "your", "we", "our", "it", "its", "they", "their", "this", "that", "these", "those",
  "there", "here", "he", "she", "i", "anyone", "anybody", "nobody", "everyone", "everybody",
  "nothing", "everything", "something", "each", "every", "both", "all", "one", "two",
  "adding", "changing", "pressing", "leaving", "sending", "saying", "asking", "doing",
  // English imperatives
  "press", "tap", "scan", "add", "open", "check", "send", "call", "log", "keep", "take",
  "use", "print", "pick", "choose", "enter", "fill", "ask", "leave", "turn", "scroll",
  "confirm", "attach", "approve", "record", "sign", "set", "give", "tell", "write", "put",
  "start", "stop", "pay", "fix", "find", "show", "hold", "save", "delete", "remove",
  // Afrikaans pronouns and determiners
  "dit", "jy", "jou", "ons", "hulle", "hul", "hy", "daar", "hier", "hierdie", "daardie",
  "elke", "niks", "alles", "niemand", "enigiemand", "almal", "iets", "u",
  // Afrikaans imperatives
  "betaal", "druk", "tik", "skandeer", "voeg", "maak", "kyk", "stuur", "bel", "hou",
  "neem", "gebruik", "kies", "vul", "vra", "los", "draai", "rol", "bevestig", "heg",
  "keur", "teken", "stel", "gee", "skryf", "sit", "begin", "stop", "soek", "wys", "stoor",
]);

/** Words that introduce an aside rather than a new thought. */
const ASIDE_STARTERS = new Set([
  "or", "and", "but", "so", "not", "no", "with", "without", "including", "even",
  "usually", "often", "always", "never", "still", "already", "just", "only", "then",
]);

/** Openers that may begin a sentence or a short aside; length decides which. */
const DETERMINERS = new Set(["the", "a", "an", "die", "n", "hierdie", "daardie"]);

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Rewrite one ` — ` join.
 *
 * Ordered by how sure the shape is: a list after the dash is a colon, a clause is a full
 * stop, and everything else is a comma, which is the safe reading of an aside.
 */
function joinProse(head, tail) {
  const trimmedHead = head.trimEnd();
  const trimmedTail = tail.trimStart();
  if (!trimmedTail) return trimmedHead;
  // The head already ended a sentence, so the dash was decoration. Close the gap.
  if (/[.!?]$/.test(trimmedHead)) return `${trimmedHead} ${capitalise(trimmedTail)}`;

  const firstWord = trimmedTail.split(/\s+/)[0].toLowerCase().replace(/[^a-z']/g, "");
  const words = trimmedTail.split(/\s+/).length;
  const headHasComma = trimmedHead.includes(",");
  const tailIsList = !headHasComma && (trimmedTail.match(/,/g) || []).length >= 2;

  // "Every machine on your farm: costs, services, faults, in one place."
  if (tailIsList) return `${trimmedHead}: ${trimmedTail}`;

  // Already a sentence of its own.
  if (/^[A-Z]/.test(trimmedTail) && words > 1) return `${trimmedHead}. ${trimmedTail}`;

  if (ASIDE_STARTERS.has(firstWord)) return `${trimmedHead}, ${trimmedTail}`;

  if (CLAUSE_STARTERS.has(firstWord) && words >= 2 && /[a-z0-9)"']$/i.test(trimmedHead)) {
    return `${trimmedHead}. ${capitalise(trimmedTail)}`;
  }

  // "…totals are fixed — the document becomes a formal record." A determiner can open
  // either a new sentence or a short noun-phrase aside, and length tells them apart: an
  // aside is two or three words, a second thought runs on.
  if (DETERMINERS.has(firstWord) && words >= 5 && /[a-z0-9)"']$/i.test(trimmedHead)) {
    return `${trimmedHead}. ${capitalise(trimmedTail)}`;
  }

  return `${trimmedHead}, ${trimmedTail}`;
}

/** Rewrite every em dash in one user-facing string. */
export function rewriteCopy(s) {
  if (!s.includes(EM) && !s.includes(EN)) return s;
  // A string that is ONLY a dash is the "no value" placeholder in a table cell, not
  // prose. It keeps its job and loses its typography.
  if (/^[\s—–-]+$/.test(s)) return "-";
  // Decoration wrapped around a word, as in "— None —" on an empty select. The dashes are
  // there to say "this is not a real choice"; the word alone says it better.
  let out = s.replace(/^[\s—–]+/, "").replace(/[\s—–]+$/, "");
  if (!out.includes(EM) && !out.includes(EN)) return out;

  // A dash with space on both sides is the parenthetical this exists to remove.
  let guard = 0;
  while (out.includes(` ${EM} `) && guard++ < 20) {
    const i = out.indexOf(` ${EM} `);
    out = joinProse(out.slice(0, i), out.slice(i + 3));
  }
  // Leading "— something" and any stragglers.
  out = out.replace(new RegExp(`\\s*${EM}\\s*`, "g"), ", ");
  // An en dash between numbers or dates is a RANGE and stays legible as a hyphen.
  out = out.replace(new RegExp(`(\\d)\\s*${EN}\\s*(\\d)`, "g"), "$1-$2");
  out = out.replace(new RegExp(`\\s*${EN}\\s*`, "g"), ", ");
  // Tidy anything the joins doubled up. Deliberately NO "put a space after punctuation"
  // rule: it turned "docs/POPIA.md" into "docs/POPIA. md" and would do the same to every
  // decimal, filename and URL in the dictionaries.
  out = out.replace(/,\s*,/g, ",").replace(/\s+([,;:])/g, "$1");
  return out.replace(/\s{2,}/g, " ").trim();
}

// ── Source rules ────────────────────────────────────────────────────────────

/**
 * Comments and banners. Mechanical on purpose: nobody is persuaded or misled by a comment,
 * so the only job here is to stop the source reading as machine-written.
 */
function rewriteSource(text) {
  let out = text;

  // Banner runs: `── Section ─────`. Left alone when any other box-drawing character is on
  // the line, because that is a drawn table and a swapped character would break it.
  out = out
    .split("\n")
    .map((line) => {
      if (!line.includes(BOX)) return line;
      if (TABLE_CHARS.test(line)) return line;
      return line.replace(new RegExp(`${BOX}+`, "g"), (run) => "=".repeat(run.length));
    })
    .join("\n");

  // Prose dashes inside comments and strings.
  out = out.replace(new RegExp(` ${EM} `, "g"), ", ");
  out = out.replace(new RegExp(`${EM}`, "g"), "-");
  out = out.replace(new RegExp(`(\\d)\\s*${EN}\\s*(\\d)`, "g"), "$1-$2");
  out = out.replace(new RegExp(`${EN}`, "g"), "-");
  return out;
}

// ── Walk ────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".vercel"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".sql", ".md", ".sh", ".css"]);

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

/**
 * Every dictionary, including the professional-tone variants.
 *
 * Missing those two is how half the product would have kept its em dashes: a farm that
 * chose the formal wording (`0372_user_language_and_tone`) reads an entirely different
 * file, and nothing on the English screens would have shown it.
 */
const I18N = [
  "src/lib/i18n/en.json",
  "src/lib/i18n/af.json",
  "src/lib/i18n/en.professional.json",
  "src/lib/i18n/af.professional.json",
].map((p) => path.join(ROOT, p));

function sweepCopy() {
  let changed = 0;
  const samples = [];
  const suspect = [];
  for (const file of I18N) {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    const walkObj = (o) => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === "object") walkObj(v);
        else if (typeof v === "string") {
          const next = rewriteCopy(v);
          if (next !== v) {
            changed += 1;
            if (samples.length < 600) samples.push(next);
            // Anything that reads like a machine slipped. Reported rather than written
            // quietly: a comma at the start of a sentence is worse than a dash.
            if (/^[,.;:]|[,;:]\s*$|,\s*,|\s[,;:]|\(\s|\s\)|\.\s*\./.test(next)) {
              suspect.push([k, v, next]);
            }
            o[k] = next;
          }
        }
      }
    };
    walkObj(obj);
    if (APPLY) {
      fs.writeFileSync(file, JSON.stringify(obj, null, 2).replace(/\n/g, "\r\n") + "\r\n");
    }
  }
  return { changed, samples, suspect };
}

function sweepSource() {
  let files = 0;
  let hits = 0;
  for (const p of walk(ROOT)) {
    if (I18N.includes(p)) continue;
    if (!SOURCE_EXT.has(path.extname(p))) continue;
    if (p.includes(`scripts${path.sep}dash_sweep.mjs`)) continue;
    const text = fs.readFileSync(p, "utf8");
    if (!text.includes(EM) && !text.includes(EN) && !text.includes(BOX)) continue;
    const next = rewriteSource(text);
    if (next === text) continue;
    files += 1;
    hits +=
      (text.match(new RegExp(EM, "g")) || []).length +
      (text.match(new RegExp(EN, "g")) || []).length;
    if (APPLY) fs.writeFileSync(p, next);
  }
  return { files, hits };
}

const copy = sweepCopy();
console.log(`copy strings rewritten: ${copy.changed}`);
if (copy.suspect.length) {
  console.log(`
NEEDS A HUMAN (${copy.suspect.length}):`);
  for (const [k, before, after] of copy.suspect) {
    console.log(`  ${k}
    before: ${before}
    after:  ${after}`);
  }
}
if (!COPY_ONLY) {
  const src = sweepSource();
  console.log(`source files rewritten: ${src.files} (${src.hits} prose dashes)`);
}
if (process.argv.includes("--samples")) {
  console.log("\n--- rewritten copy ---");
  for (const s of copy.samples) console.log("  " + s);
}
console.log(APPLY ? "\nWRITTEN" : "\ndry run; pass --apply to write");
