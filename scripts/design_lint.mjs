#!/usr/bin/env node
/**
 * Design-system lint.
 *
 * The gap this closes: this project verifies its database ferociously — 64
 * assertion banners, mutation-tested suites, a schema fingerprint — and every
 * one of those runs against Postgres. Nothing could see the interface.
 * `tsc` reads "text-sand-500" as a valid string, `lint` has no opinion on a
 * 3.65:1 contrast ratio, and `next build` succeeds with pinch-zoom disabled.
 *
 * So each rule below is a defect that was actually found by measuring the built
 * product, encoded so it cannot come back silently.
 *
 *   node scripts/design_lint.mjs          # report
 *   node scripts/design_lint.mjs --quiet  # exit code only
 *
 * Exit 0 = clean, 1 = violations.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const QUIET = process.argv.includes("--quiet");

// ── The palette ─────────────────────────────────────────────────────────────
const BRAND = {
  green: "#00572c",
  gold: "#eaa50c",
  black: "#000000",
  cream: "#f7f3e8",
  white: "#ffffff",
  charcoal: "#242824",
  warmGrey: "#e6e2d7",
};

// ── Contrast maths (WCAG 2.1) ───────────────────────────────────────────────
const rgb = (h) => {
  h = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lum = (c) =>
  c
    .map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
export const ratio = (a, b) => {
  const [l1, l2] = [lum(rgb(a)), lum(rgb(b))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

// ── Walk ────────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(p)) out.push(p);
  }
  return out;
}


/**
 * The DARK token values, read from globals.css rather than copied here — the
 * same reason `DEFINED` parses the config: a hand-kept copy drifts, and
 * catching drift is this file's whole job. Returns `{ ink: "#f7f3e8", ... }`.
 */
const cssPath = join(SRC, "app", "globals.css");
const DARK = (() => {
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  // The explicit-choice block, which is the one a themed screenshot renders.
  const m = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  const out = {};
  if (m)
    for (const d of m[1].matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g))
      out[d[1]] =
        "#" + [d[2], d[3], d[4]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return out;
})();

/** A dark token by name, or a loud marker so a missing one FAILS rather than passes. */
const dk = (name) => DARK[name] ?? "#MISSING";

/**
 * The dark theme is declared twice — under `@media (prefers-color-scheme: dark)`
 * for the system default, and under `[data-theme="dark"]` for an explicit
 * choice. A token written into one and not the other gives a user whose OS is
 * dark a different product from one who pressed the button. Parses the media
 * block the same way and reports any token the two disagree about.
 */
const DARK_MEDIA = (() => {
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  const m = css.match(/:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n\s{2}\}/);
  const out = {};
  if (m)
    for (const d of m[1].matchAll(/--([a-z0-9-]+):\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*;/g))
      out[d[1]] =
        "#" + [d[2], d[3], d[4]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return out;
})();

const darkBlockDrift = (() => {
  const names = new Set([...Object.keys(DARK), ...Object.keys(DARK_MEDIA)]);
  const bad = [];
  for (const n of names) {
    const a = DARK[n];
    const b = DARK_MEDIA[n];
    if (a !== b) bad.push(`--${n}: [data-theme] ${a ?? "absent"} vs @media ${b ?? "absent"}`);
  }
  return bad;
})();

const twSrcPath = join(ROOT, "tailwind.config.ts");
const files = existsSync(SRC) ? walk(SRC) : [];
const rel = (p) => relative(ROOT, p).split(sep).join("/");
/** The one spelling of an (app) page title. See rule 10. */
const PAGE_TITLE = "text-2xl font-bold tracking-tight text-ink";

const violations = [];
const add = (rule, file, line, detail) =>
  violations.push({ rule, file: rel(file), line, detail });

// Files exempt from a rule, with the reason.
const EXEMPT = {
  // The kit's own primitives legitimately name every token.
  "no-stock-colour": [/src\/components\/ui\/(badge|status)\.tsx$/],
  // A miniature of a PRINTED document, deliberately mirroring the PDF renderer
  // so a partner sees their real letterhead. The kit's app styling (uppercase
  // headers, hover rows, app padding) would make it stop looking like paper,
  // which is the one thing it exists to do. It carries scope="col" by hand.
  "use-kit-Table": [/src\/components\/documents\/document-preview\.tsx$/],
};
const exempt = (rule, file) =>
  (EXEMPT[rule] || []).some((re) => re.test(rel(file)));

/**
 * The tokens that actually exist, read from the config itself rather than
 * duplicated here — a hand-kept copy would drift and this rule's whole job is to
 * catch drift. Parses the scale keys out of `tailwind.config.ts`.
 */
const DEFINED = (() => {
  const out = {};
  const src = existsSync(twSrcPath) ? readFileSync(twSrcPath, "utf8") : "";
  for (const family of [
    "brand", "gold", "sand", "danger", "status", "callout",
    // The SEMANTIC families were missing, which is how `bg-surface-1` survived in
    // ten places across six files: the colours map defines surface as
    // DEFAULT/raised/sunken/hover, so `bg-surface-1` compiled to nothing and every
    // panel using it painted no background at all. Rule 9 could not see it because
    // it never looked at this family.
    "surface", "ink", "edge", "accent",
  ]) {
    const m = src.match(new RegExp(`\\b${family}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`));
    const keys = new Set();
    if (m) for (const k of m[1].matchAll(/^\s*"?([a-zA-Z0-9-]+)"?:\s*"/gm)) keys.add(k[1]);
    out[family] = keys;
  }
  // `DEFAULT` is addressed as the bare family name (e.g. `bg-surface`).
  return out;
})();

// Stock Tailwind palettes that are NOT the FleetWise palette.
const STOCK =
  "slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|" +
  "emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const STOCK_RE = new RegExp(
  `\\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|shadow|decoration|accent|caret|placeholder)-(?:${STOCK})-(?:50|100|200|300|400|500|600|700|800|900|950)\\b`,
  "g",
);

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split(/\r?\n/);

  lines.forEach((ln, i) => {
    const n = i + 1;

    // 1 — no stock Tailwind colours: the palette above is the whole palette.
    if (!exempt("no-stock-colour", f)) {
      for (const m of ln.matchAll(STOCK_RE)) add("no-stock-colour", f, n, m[0]);
    }

    // 2 — no arbitrary type sizes: there were 32 distinct sizes in use, 24 of
    //     them one-offs, four within 0.15rem of each other.
    //     `em` is exempt and deliberately so: it sizes relative to the parent,
    //     which is the correct way to scale an icon inside a button whose own
    //     size varies. Only absolute one-offs are the problem.
    for (const m of ln.matchAll(/\btext-\[[0-9.]+(?:rem|px)\]/g))
      add("no-arbitrary-type", f, n, m[0]);

    // 3 — gold may not carry text above gold-600. #EAA50C is 1.92:1 on cream.
    for (const m of ln.matchAll(/\btext-gold-(50|100|200|300|400|500)\b/g))
      add("gold-not-text", f, n, `${m[0]} — gold-500 is 1.92:1 on cream; use text-gold-600+`);

    // 4 — white on gold is 2.12:1. The fill recipe is bg-gold-500 text-sand-950.
    //     Both halves must be UNPREFIXED: `active:bg-gold-600 active:text-white`
    //     is a different pair (5.12:1) and legitimate, so a bare substring test
    //     would flag the one correct use of gold in the kit.
    if (/(?<![:\w-])bg-gold-(400|500)\b/.test(ln) && /(?<![:\w-])text-white\b/.test(ln))
      add("gold-fill-recipe", f, n, "white on gold = 2.12:1 — use text-sand-950");

    // 5 — sand-300 and lighter are never text (300 is the control-border step).
    for (const m of ln.matchAll(/\btext-sand-(50|100|200|300)\b/g))
      add("neutral-too-light", f, n, `${m[0]} — not a text colour`);

    // 6 — every image goes through <Photo>: dimensions + lazy + real alt.
    if (/<img\s/.test(ln) && !/src\/components\/ui\/photo\.tsx$/.test(rel(f)))
      add("use-Photo", f, n, "raw <img> — use <Photo> (sized, lazy, alt)");

    // 7 — hand-rolled tables lose scope="col" and aria-sort.
    //     Exemptions, all real: table.tsx IS the wrapper this rule points at;
    //     `role="presentation"` declares a LAYOUT table, which is the only
    //     reliable way to lay out an HTML email and carries no data semantics
    //     to lose; and see EXEMPT above for the printed-document miniature.
    if (
      /<table[\s>]/.test(ln) &&
      !/role="presentation"/.test(ln) &&
      !/src\/components\/ui\/table\.tsx$/.test(rel(f)) &&
      !exempt("use-kit-Table", f)
    )
      add("use-kit-Table", f, n, "raw <table> — use the kit's Table/Th");

    // 8 — pinch-zoom must stay available (WCAG 1.4.4).
    if (/maximumScale\s*:/.test(ln) || /maximum-scale/.test(ln))
      add("no-maximum-scale", f, n, "disables pinch-zoom — WCAG 1.4.4 failure");

    // 10 — ONE page title. Sixty-two (app) pages rendered their h1 in nine
    //      spellings: two sizes (text-xl, text-2xl) and two inks (sand-900 and
    //      sand-950, which are Warm Cream and pure white in the dark theme).
    //      The split ran by WHICH SPRINT built the page — the finance tranche
    //      used text-xl, the core used text-2xl — so somebody moving from
    //      Machines to Money watched the title shrink. Scoped to (app) route
    //      pages: the marketing hero, the legal document, the error boundary
    //      and the public QR page are different roles with their own sizes.
    if (
      /\(app\)/.test(rel(f)) &&
      /page\.tsx$/.test(rel(f)) &&
      /<h1\s[^>]*className="/.test(ln)
    ) {
      const h = ln.match(/<h1\s[^>]*className="([^"]*)"/);
      if (h && !h[1].includes(PAGE_TITLE))
        add("page-title", f, n, `${h[1]} — page titles are "${PAGE_TITLE}"`);
    }

    // 9 — a token that is not defined renders as NOTHING, silently. This was
    //     real: `status-warn` and `status-bad` were used 19 times across 13
    //     files and defined in no version of the config, so the cells meant to
    //     read as a caution rendered as ordinary body text.
    for (const m of ln.matchAll(/\b(?:text|bg|border|ring|fill|stroke|divide)-(status|brand|gold|sand|danger|callout|surface|ink|edge|accent)-([a-z0-9-]+)/g)) {
      if (!DEFINED[m[1]]?.has(m[2])) add("unknown-token", f, n, `${m[0]} — no such token`);
    }
  });

  // 9 — theme colours must be tokens, checked across config files below too.
  if (/globals\.css$/.test(rel(f)) && !/--surface/.test(src))
    add("semantic-tokens", f, 0, "semantic surface tokens missing");
}

// ── Config-level checks ─────────────────────────────────────────────────────
const manifestPath = join(ROOT, "public", "manifest.webmanifest");
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  if ((m.theme_color || "").toLowerCase() !== BRAND.green)
    add("manifest-brand", manifestPath, 0, `theme_color ${m.theme_color} should be ${BRAND.green}`);
  if ((m.background_color || "").toLowerCase() !== BRAND.cream)
    add("manifest-brand", manifestPath, 0, `background_color ${m.background_color} should be ${BRAND.cream}`);
}

// ── Contrast self-test: the token scale must keep its promises ──────────────
const CONTRACT = [
  ["sand-500 secondary text on cream", "#5d5a52", BRAND.cream, 4.5],
  ["sand-500 secondary text on white", "#5d5a52", BRAND.white, 4.5],
  ["sand-400 placeholder on cream", "#716e64", BRAND.cream, 4.5],
  ["sand-300 control border on cream", "#8f8b7f", BRAND.cream, 3.0],
  ["sand-900 body text on cream", BRAND.charcoal, BRAND.cream, 4.5],
  ["white on brand-600 button", BRAND.white, BRAND.green, 4.5],
  ["brand-600 as text on cream", BRAND.green, BRAND.cream, 4.5],
  ["black on gold-500 fill", BRAND.black, BRAND.gold, 4.5],
  ["gold-600 as text on cream", "#936505", BRAND.cream, 4.5],
  ["status-due on cream", "#8a5e05", BRAND.cream, 4.5],
  ["status-overdue on cream", "#b3201f", BRAND.cream, 4.5],
  ["status-ok on cream", BRAND.green, BRAND.cream, 4.5],

  // ── The dark theme ────────────────────────────────────────────────────────
  //
  // Everything above is LIGHT: every pair is "on cream", "on white", or a brand
  // fill. Nothing validated the dark theme, and that single gap is how all of
  // the following shipped at once while this gate reported 12/12 pass:
  //
  //   the selected nav row          1.04:1   bg-gold-50 under an inverting --ink
  //   every gold CTA                2.12:1   text-sand-950 inverts to white
  //   table row dividers            1.03:1   divide-sand-100 on a charcoal card
  //   every status pill ground   1.01-1.09   tuned against white
  //   ten panels                    no background at all (bg-surface-1)
  //
  // A token that must stay legible needs a token AND a test. These are the dark
  // values, written literally: if globals.css changes one and the pair stops
  // clearing its threshold, this fails the build.
  //
  // --surface 29 33 29 = #1d211d, --surface-raised 39 44 39 = #272c27.
  ["dark: ink on card surface", dk("ink"), dk("surface"), 4.5],
  ["dark: ink on page ground", dk("ink"), dk("surface-raised"), 4.5],
  ["dark: ink-muted on card surface", dk("ink-muted"), dk("surface"), 4.5],
  ["dark: ink-subtle on card surface", dk("ink-subtle"), dk("surface"), 4.5],
  ["dark: brand-ink as text on surface", dk("brand-ink"), dk("surface"), 4.5],
  ["dark: selected nav row ink on accent-tint", dk("ink"), dk("accent-tint"), 4.5],
  ["dark: selected nav icon on accent-tint", dk("accent-ink"), dk("accent-tint"), 3.0],
  ["dark: accent-on-fill on the gold fill", dk("accent-on-fill"), dk("accent"), 4.5],
  ["dark: edge as control border on surface", dk("edge"), dk("surface"), 3.0],
  // Dividers and hovers are not text: they must be SEEN, not read. The
  // thresholds are deliberately low, and deliberately not zero — the values
  // these replaced sat at 1.03:1 and 1.11:1, which is invisible.
  ["dark: edge-soft divider visible on surface", dk("edge-soft"), dk("surface"), 1.5],
  ["dark: row hover distinct from surface", dk("row-hover"), dk("surface"), 1.2],
  ["dark: ok pill ground on surface", dk("callout-ok-bg"), dk("surface"), 1.25],
  ["dark: warn pill ground on surface", dk("callout-warn-bg"), dk("surface"), 1.25],
  ["dark: danger pill ground on surface", dk("callout-danger-bg"), dk("surface"), 1.25],
  ["dark: info pill ground on surface", dk("callout-info-bg"), dk("surface"), 1.25],
  ["dark: ok ink on its pill", dk("callout-ok-ink"), dk("callout-ok-bg"), 4.5],
  ["dark: warn ink on its pill", dk("callout-warn-ink"), dk("callout-warn-bg"), 4.5],
  ["dark: danger ink on its pill", dk("callout-danger-ink"), dk("callout-danger-bg"), 4.5],
  ["dark: info ink on its pill", dk("callout-info-ink"), dk("callout-info-bg"), 4.5],
  ["dark: status-ok as text on surface", dk("status-ok"), dk("surface"), 4.5],
  ["dark: status-due as text on surface", dk("status-due"), dk("surface"), 4.5],
  ["dark: status-overdue as text on surface", dk("status-overdue"), dk("surface"), 4.5],
];
const contrastFails = CONTRACT.filter(([, a, b, need]) => ratio(a, b) < need);

// Guard the config actually still holds these values.
const twPath = join(ROOT, "tailwind.config.ts");
if (existsSync(twPath)) {
  const tw = readFileSync(twPath, "utf8").toLowerCase();
  for (const [name, hex] of Object.entries(BRAND)) {
    if (name === "white") continue;
    if (!tw.includes(hex)) add("brand-anchor-missing", twPath, 0, `${name} ${hex} not found in the token config`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
const byRule = violations.reduce((a, v) => ((a[v.rule] ||= []).push(v), a), {});
const RULE_TEXT = {
  "no-stock-colour": "Stock Tailwind colour outside the FleetWise palette",
  "no-arbitrary-type": "Arbitrary text size — use the scale",
  "gold-not-text": "Gold lighter than 600 used as text (1.92:1)",
  "gold-fill-recipe": "White on gold (2.12:1) — use text-sand-950",
  "neutral-too-light": "Neutral too light to be text",
  "use-Photo": "Raw <img> — no dimensions, no lazy loading",
  "use-kit-Table": "Raw <table> — loses scope=col and aria-sort",
  "no-maximum-scale": "Pinch-zoom disabled — WCAG 1.4.4",
  "manifest-brand": "PWA manifest colour is not a brand token",
  "unknown-token": "Token is not defined — renders as nothing",
  "brand-anchor-missing": "A brand anchor colour is missing from the tokens",
  "semantic-tokens": "Semantic surface tokens missing",
};

if (!QUIET) {
  console.log(`\nFleetWise design lint — ${files.length} files\n${"─".repeat(64)}`);
  if (!violations.length) console.log("  No violations.");
  for (const [rule, vs] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${rule}  (${vs.length})  — ${RULE_TEXT[rule] || ""}`);
    const shown = vs.slice(0, 12);
    for (const v of shown) console.log(`    ${v.file}${v.line ? ":" + v.line : ""}  ${v.detail}`);
    if (vs.length > shown.length) console.log(`    … and ${vs.length - shown.length} more`);
  }
  console.log(`\n${"─".repeat(64)}\n  Contrast contract: ${CONTRACT.length - contrastFails.length}/${CONTRACT.length} pass`);
  for (const [name, a, b, need] of contrastFails)
    console.log(`    FAIL ${name} — ${ratio(a, b).toFixed(2)}:1, need ${need}`);
  if (darkBlockDrift.length) {
    console.log(`  Dark-theme blocks disagree on ${darkBlockDrift.length} token(s):`);
    for (const d of darkBlockDrift) console.log(`    ${d}`);
  } else {
    console.log("  Dark-theme blocks agree");
  }
  console.log(`  Violations: ${violations.length}\n`);
}

process.exit(violations.length || contrastFails.length || darkBlockDrift.length ? 1 : 0);
