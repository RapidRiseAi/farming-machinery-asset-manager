#!/usr/bin/env node
/**
 * Every error a user can be shown must be a translated sentence.
 *
 * Server actions reject by redirecting to `?error=<something>` on 259 paths, and
 * 232 of those historically carried raw English or a raw Postgres message.
 * Pages rendered whatever arrived, so an Afrikaans farmer could be shown
 * `need-name`, `po-needQty`, or a Supabase string — in an app that keeps 3,600+
 * translation keys at parity. Nothing could catch it: `tsc` sees a valid string,
 * `lint` has no opinion, the build succeeds.
 *
 * This closes the loop in both directions:
 *   1. every code in `lib/errors.ts` resolves to a key present in BOTH
 *      dictionaries, and the Afrikaans is not just the English copied across;
 *   2. every code the CODEBASE actually emits is in the map.
 *
 *   node scripts/error_coverage.mjs
 *
 * Exit 0 = clean, 1 = a code would reach someone untranslated.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const en = JSON.parse(readFileSync("src/lib/i18n/en.json", "utf8"));
const af = JSON.parse(readFileSync("src/lib/i18n/af.json", "utf8"));
const get = (o, p) => p.split(".").reduce((c, k) => (c == null ? c : c[k]), o);

// ── 1. Read the map ─────────────────────────────────────────────────────────
const src = readFileSync("src/lib/errors.ts", "utf8");
const body = src.slice(src.indexOf("const CODE_KEYS"), src.indexOf("\n};", src.indexOf("const CODE_KEYS")));
const FALLBACK = (src.match(/const FALLBACK = "([^"]+)"/) ?? [])[1];
// Values are either a quoted key or the FALLBACK identifier.
const pairs = [...body.matchAll(/^\s*"?([A-Za-z0-9-]+)"?:\s*(?:"([a-zA-Z.]+)"|(FALLBACK)),/gm)]
  .map((m) => [m[1], m[3] ? FALLBACK : m[2]]);

const problems = [];
for (const [code, key] of pairs) {
  if (typeof get(en, key) !== "string") problems.push(`missing in en.json: ${key}  (code "${code}")`);
  else if (typeof get(af, key) !== "string") problems.push(`missing in af.json: ${key}  (code "${code}")`);
  else if (get(en, key) === get(af, key)) problems.push(`af is identical to en: ${key}`);
}

// ── 2. Every code the app emits must be covered ─────────────────────────────
function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(d, e);
    statSync(p).isDirectory() ? walk(p, out) : /\.tsx?$/.test(p) && out.push(p);
  }
  return out;
}
// Mirrors `normalise()` in lib/errors.ts.
const norm = (s) =>
  s.trim().toLowerCase().replace(/[+_\s]+/g, "-").replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");

/**
 * Codes deliberately handled somewhere other than the shared map.
 * Each needs a reason, so an unexplained gap stays visible.
 */
const HANDLED_ELSEWHERE = new Map([
  ["invalid-login-credentials", "login/page.tsx matches Supabase wording directly"],
  ["invalid-login", "login/page.tsx"],
  ["not-confirmed", "login/page.tsx"],
  ["rate-limit", "login/page.tsx"],
]);

const known = new Set(pairs.map(([c]) => c));
const emitted = new Map();
for (const f of walk("src/app")) {
  const text = readFileSync(f, "utf8");
  // Capture the WHOLE value, commas included — `?error=Email,+name+and+role+required`
  // is one message, and stopping at the comma invents a phantom code "email".
  for (const m of text.matchAll(/[?&]error=([^"'`&\s)]+)/g)) {
    let v = m[1];
    if (v.includes("$")) continue; // interpolated at runtime
    const c = norm(decodeURIComponent(v.replace(/\+/g, " ")));
    if (c) emitted.set(c, f);
  }

  // The literal scan above misses the shape most of this product actually uses: a local
  // helper that interpolates the code.
  //
  //     function bounce(code: string): never {
  //       redirect(`/billing?error=${encodeURIComponent(code)}`);
  //     }
  //
  // Every code in billing, activate, closed and account actions went through one of those
  // and was therefore invisible here — measured by injecting an unmapped code and watching
  // this check report "Clean". Only files that DEFINE such a helper are scanned for
  // `bounce(...)` calls, so an unrelated function of the same name elsewhere cannot make
  // this invent codes.
  const definesBounce = /function\s+bounce\s*\(/.test(text) && /[?&]error=/.test(text);
  if (definesBounce) {
    for (const call of text.matchAll(/\bbounce\s*\(([^;]*?)\)\s*;/g)) {
      // Drop the operands of a comparison first. In
      //     bounce(outcome.reason === "charging-disabled" ? "billing-unavailable" : "…")
      // only the branches are codes; "charging-disabled" is the thing being TESTED, and
      // reporting it sends somebody to write a sentence for an error that cannot happen.
      const args = call[1].replace(/[!=]==?\s*["'`][^"'`]*["'`]/g, "");
      // What is left is the result branches — a ternary contributes both, which is right.
      for (const lit of args.matchAll(/["'`]([A-Za-z0-9][A-Za-z0-9 ,.+-]*)["'`]/g)) {
        const c = norm(lit[1]);
        if (c) emitted.set(c, f);
      }
    }
  }
}
const uncovered = [...emitted].filter(([c]) => !known.has(c) && !HANDLED_ELSEWHERE.has(c));

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\nError coverage\n${"─".repeat(58)}`);
console.log(`  ${pairs.length} codes in the map, all resolving in en + af`);
console.log(`  ${emitted.size} distinct codes emitted across src/app`);
for (const p of problems) console.log(`  PROBLEM  ${p}`);
for (const [c, f] of uncovered) console.log(`  UNCOVERED  "${c}"  emitted by ${f}`);
const failed = problems.length + uncovered.length;
console.log(`${"─".repeat(58)}\n  ${failed === 0 ? "Clean." : failed + " problem(s)."}\n`);
process.exit(failed ? 1 : 0);
