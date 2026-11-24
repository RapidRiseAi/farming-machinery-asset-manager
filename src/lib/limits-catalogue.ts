// The limits catalogue as a document (A6, BRIEF section 25 item 2): every entry of LIMITS, grouped by
// kind, with its value in plain units and why it exists. docs/final-dev/LIMITS-CATALOGUE.md is this
// output; a test fails when the two differ. Regenerate with:
//   pnpm exec tsx scripts/limits_catalogue.ts
import { LIMITS, type LimitEntry, type LimitKind } from "./limits";

const KIND_TITLES: Record<LimitKind, string> = {
  commercial: "Commercial limits (what a plan or decision promises)",
  abuse: "Protections against misuse",
  provider: "Provider restrictions",
  window: "Display and query windows",
};

function plain(entry: LimitEntry): string {
  const v = entry.value;
  // Grouped by hand with a plain space: locale formatting differs between Node builds (CI and here).
  const n = (x: number, digits = 2) => {
    const [whole, frac] = String(Number(x.toFixed(digits))).split(".");
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${frac ? `.${frac}` : ""}`;
  };
  switch (entry.unit) {
    case "bytes":
      if (v % 1_048_576 === 0 && v % 1_000_000 !== 0) return `${n(v / 1_048_576)} MiB (${n(v, 0)} bytes)`;
      if (v >= 1_000_000) return `${n(v / 1_000_000)} MB (${n(v, 0)} bytes)`;
      if (v >= 1000) return `${n(v / 1000)} kB (${n(v, 0)} bytes)`;
      return `${n(v, 0)} bytes`;
    case "ms":
      if (v >= 86_400_000 && v % 86_400_000 === 0) return `${n(v / 86_400_000)} days`;
      if (v >= 3_600_000 && v % 3_600_000 === 0) return `${n(v / 3_600_000)} hours`;
      if (v >= 60_000 && v % 60_000 === 0) return `${n(v / 60_000)} minutes`;
      if (v >= 1000) return `${n(v / 1000)} seconds`;
      return `${n(v, 0)} ms`;
    case "bps":
      return `${n(v / 1000)} kbit/s`;
    default:
      return `${n(v)} ${entry.unit}`;
  }
}

export function limitsCatalogueMarkdown(): string {
  const entries = Object.entries(LIMITS) as [string, LimitEntry][];
  const lines = [
    "# Limits catalogue",
    "",
    "Generated from `src/lib/limits.ts` by `pnpm exec tsx scripts/limits_catalogue.ts` (A6). Do not edit by hand:",
    "change the table in code and regenerate; `src/lib/limits-catalogue.test.ts` fails when they differ.",
    "Media sizes are decimal (1 MB = 1,000,000 bytes) unless a limit says MiB. docs/LIMITS.md explains",
    "the reasoning, the provider facts and how files travel.",
    "",
    `${entries.length} limits. "Shown" means the limit is stated to customers (help, plan pages, error messages).`,
  ];
  for (const kind of Object.keys(KIND_TITLES) as LimitKind[]) {
    const group = entries.filter(([, e]) => e.kind === kind);
    if (group.length === 0) continue;
    lines.push("", `## ${KIND_TITLES[kind]}`, "", "| Name | Value | Shown | Why |", "|---|---|---|---|");
    for (const [name, e] of group) lines.push(`| \`${name}\` | ${plain(e)} | ${e.customer ? "yes" : ""} | ${e.why.replace(/\|/g, "\\|")} |`);
  }
  return `${lines.join("\n")}\n`;
}
