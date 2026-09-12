/**
 * Every translation key the code asks for must exist — in BOTH languages.
 *
 * ── Why this is a separate gate from `i18n:parity` ───────────────────────────
 * `i18n:parity` compares en.json to af.json. That catches a key present in one and missing
 * from the other, and it passes happily when a key is missing from BOTH — which is the
 * common case, because keys are usually added to neither.
 *
 * Nothing else catches it either. `t()` returns the key itself on a miss, so typecheck sees
 * a valid string, lint has no opinion, and the build succeeds. The only symptom is a screen
 * reading `reportSchedules.title` to a customer.
 *
 * That has now happened three times on this project:
 *   · 115 keys behind `/reports/schedules`, including the body of the emailed report, which
 *     would have gone to accountants and banks reading `reportEmail.greeting`;
 *   · 184 billing keys that were written but never merged;
 *   · and the "What is this?" panels on `/billing`, `/admin/billing` and
 *     `/reports/schedules`, which were rendering raw keys to users until this gate found
 *     them.
 *
 * ── The two things it checks ─────────────────────────────────────────────────
 * 1. STATIC keys — `t("some.key")`, the ordinary case.
 * 2. `infoKey` — `PageInfoButton` builds `pageInfo.${infoKey}Title` / `…What` / `…Does` /
 *    `…Note` at RUNTIME, so no static sweep can see them. `Note` is optional in the
 *    component and is not required here.
 *
 * Dynamic `` t(`stem.${x}`) `` keys are reported as stems only: the possible values are not
 * knowable from the source, so the gate checks the stem resolves to a GROUP rather than
 * pretending to check the leaves.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const en = JSON.parse(readFileSync(join(ROOT, "src/lib/i18n/en.json"), "utf8"));
const af = JSON.parse(readFileSync(join(ROOT, "src/lib/i18n/af.json"), "utf8"));

const look = (dict, key) =>
  key.split(".").reduce((o, s) => (o && typeof o === "object" ? o[s] : undefined), dict);

function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = sources(join(ROOT, "src"));
const problems = [];
let staticKeys = 0;
let stems = 0;
let infoKeys = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const where = relative(ROOT, file).split(sep).join("/");

  // 1. t("some.key")
  for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
    const key = m[1];
    // A trailing dot means the key is completed by concatenation at the call site. Those
    // are a different shape and are checked by eye; `errorMessage()` exists so the one that
    // mattered no longer needs to be.
    if (key.endsWith(".")) continue;
    staticKeys += 1;
    const inEn = typeof look(en, key) === "string";
    const inAf = typeof look(af, key) === "string";
    if (!inEn || !inAf) {
      problems.push(`${key}  en=${inEn ? "yes" : "NO "} af=${inAf ? "yes" : "NO "}  ${where}`);
    }
  }

  // 2. Dynamic keys. The leaf is not knowable from the source, so the check is that the
  //    STEM leads somewhere real. Two shapes are both legitimate here and an earlier
  //    version of this gate cried wolf on the second:
  //
  //      t(`plan.${p}`)            -> `plan` is a GROUP of translations
  //      t(`ui.status${Suffix}`)   -> `ui.statusOk` is a FLAT key with a common PREFIX
  //
  //    Nine call sites use the prefix form (ui.status…, audit.device…, jobcards.kind_…),
  //    and reporting them as missing would have made this gate noise. A checker that cries
  //    wolf stops being read.
  for (const m of src.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]*)\$\{/g)) {
    const stem = m[1];
    stems += 1;
    if (!stem) {
      problems.push(`(empty dynamic stem)  ${where}`);
      continue;
    }
    const leadsSomewhere = (dict) => {
      const asGroup = look(dict, stem.replace(/\.$/, ""));
      if (asGroup && typeof asGroup === "object") return true;
      // The prefix form: everything before the last dot is the group, the rest is a prefix
      // shared by real keys inside it.
      const cut = stem.lastIndexOf(".");
      if (cut < 0) return false;
      const parent = look(dict, stem.slice(0, cut));
      const prefix = stem.slice(cut + 1);
      return (
        !!parent &&
        typeof parent === "object" &&
        Object.keys(parent).some((k) => k.startsWith(prefix))
      );
    };
    if (!leadsSomewhere(en) || !leadsSomewhere(af)) {
      problems.push(`${stem}*  leads nowhere in both dictionaries  ${where}`);
    }
  }

  // 3. infoKey="…" — built into four keys at runtime by PageInfoButton.
  for (const m of src.matchAll(/infoKey=["']([a-zA-Z0-9_]+)["']/g)) {
    infoKeys += 1;
    for (const suffix of ["Title", "What", "Does"]) {
      const key = `pageInfo.${m[1]}${suffix}`;
      const inEn = typeof look(en, key) === "string";
      const inAf = typeof look(af, key) === "string";
      if (!inEn || !inAf) {
        problems.push(`${key}  en=${inEn ? "yes" : "NO "} af=${inAf ? "yes" : "NO "}  ${where}`);
      }
    }
  }
}

console.log("");
console.log("i18n key coverage");
console.log("──────────────────────────────────────────────────────────");
console.log(`  ${files.length} source files`);
console.log(`  ${staticKeys} static t() keys, ${stems} dynamic stems, ${infoKeys} page-info keys`);
console.log("──────────────────────────────────────────────────────────");

if (problems.length) {
  for (const p of [...new Set(problems)]) console.log(`  ${p}`);
  console.log("");
  console.log(`  ${new Set(problems).size} key(s) the code asks for and the dictionaries do not have.`);
  console.log("  `t()` returns the key on a miss, so these render to users verbatim.");
  process.exit(1);
}

console.log("  Every key the code asks for exists in both languages.");
console.log("");
