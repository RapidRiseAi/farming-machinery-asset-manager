/**
 * The rules that keep repeated taps harmless, checked across the whole source tree.
 *
 * The components make a control safe (`DownloadLink`, `SubmitButton`, `ActionButton`);
 * these keep the next screen from quietly going back to the unsafe version. A plain
 * `<a>` to a file route downloads once per tap, which is the bug the founder hit.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DOWNLOAD_HEADER } from "@/lib/download";

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

/** Each `<a ...>` opening tag in a file, with the line it starts on. */
function anchors(text: string): Array<{ tag: string; line: number }> {
  const found: Array<{ tag: string; line: number }> = [];
  const re = /<a[\s>]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = match.index; i < text.length; i += 1) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    found.push({ tag: text.slice(match.index, end + 1), line: text.slice(0, match.index).split("\n").length });
  }
  return found;
}

/** An href that points at a route answering with a file. */
const FILE_ROUTE = /href=\{?[^>]*(\.pdf|\/pdf\b|\.csv|\/csv\b|\.xlsx|\/export\b|\/api\/packs\/|\/remittance\/|pdfHref|csvHref|stmtPdf|stmtCsv|remitPdf|remitCsv)/;

test("every link to a file is a DownloadLink, so a second tap does not download it again", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const { tag, line } of anchors(text)) {
      if (FILE_ROUTE.test(tag)) offenders.push(`${file.slice(SRC.length + 1)}:${line}  ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `plain <a> links to file routes; use DownloadLink:\n${offenders.join("\n")}`);
});

/**
 * A route to a file written anywhere in a screen: a literal starting with "/" naming a
 * PDF, CSV, workbook, export or pack. Catches the link the test above cannot see, one
 * built by a helper from a variable (the reports page's `csvLink(path)` was one).
 */
const FILE_ROUTE_LITERAL = /["'`]\/[^"'`\s]*(\.pdf|\/pdf\b|\.csv|\/csv\b|\.xlsx|\/export\b|\/packs\/|\/remittance\/)/;

/** Screens that mention a file route without linking to it, and why. */
const MENTIONS_WITHOUT_LINK: Record<string, string> = {};

test("every screen that names a file route links to it through DownloadLink", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
    if (rel === "components/ui/download-link.tsx" || rel in MENTIONS_WITHOUT_LINK) continue;
    const text = readFileSync(file, "utf8");
    if (!FILE_ROUTE_LITERAL.test(text)) continue;
    if (!/import \{[^}]*\bDownloadLink\b[^}]*\} from "@\/components\/ui\/download-link"/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `these name a file route but never use DownloadLink:\n${offenders.join("\n")}`);
});

/**
 * Raw submit buttons that are right as they are, each with the reason. Every other submit
 * is a `SubmitButton`, which locks its form while the post is out. A raw one does not:
 * a second tap posts the form a second time.
 */
const RAW_SUBMIT_REVIEWED: Record<string, { count: number; why: string }> = {
  "app/(app)/machines/[id]/page.tsx": { count: 1, why: "GET form choosing the usage date; nothing changes" },
  "app/(app)/statements/picker.tsx": { count: 1, why: "client form that only changes the period shown" },
  "app/(app)/suppliers/[id]/page.tsx": { count: 2, why: "GET forms choosing a statement period or payment date" },
  "app/(public)/m/[token]/page.tsx": { count: 1, why: "GET form that reloads the QR page" },
  "components/ui/search-field.tsx": { count: 1, why: "GET search; the hidden button keeps Enter working without JavaScript" },
  "components/expenses/receipt-upload.tsx": { count: 1, why: "inside <noscript>, only rendered without JavaScript" },
  "components/ui/language-switcher.tsx": { count: 1, why: "sets the language; a second tap sets the same one" },
  "components/ui/device-language-switcher.tsx": { count: 1, why: "sets the language; a second tap sets the same one" },
  "components/ui/tone-switcher.tsx": { count: 1, why: "sets the tone; a second tap sets the same one" },
  "components/ui/site-switcher.tsx": { count: 1, why: "opens a farm; a second tap opens the same one" },
  "app/(app)/account/whatsapp/whatsapp-settings.tsx": { count: 1, why: "client submit that returns while busy" },
  "app/(auth)/mfa/setup/setup-form.tsx": { count: 1, why: "client submit behind a ref lock" },
  "app/(auth)/mfa/verify/verify-form.tsx": { count: 1, why: "client submit behind a ref lock" },
  "components/fault-capture.tsx": { count: 1, why: "client submit that returns while busy; queued with a client id" },
  "components/jobcard-media.tsx": { count: 1, why: "client submit that returns while busy; retries reuse the capture id" },
  "components/partner/upload-document.tsx": { count: 1, why: "client submit that returns while busy; retries reuse the capture id" },
  "components/work-request-media.tsx": { count: 1, why: "client submit that returns while busy" },
  "components/statements/send-statement.tsx": { count: 1, why: "client submit behind a ref lock, with a request id the server dedupes" },
  "components/ui/leaving-form.tsx": { count: 1, why: "native post that leaves the page (PayFast), locked in onSubmit" },
};

test("every submit button locks its form, or is reviewed as harmless", () => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of sources(SRC)) {
    const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
    if (rel === "components/ui/submit-button.tsx") continue;
    const text = readFileSync(file, "utf8");
    const count = (text.match(/<(?:button|Button)\b[^>]*?\btype="submit"/g) ?? []).length;
    if (!count) continue;
    seen.add(rel);
    const reviewed = RAW_SUBMIT_REVIEWED[rel];
    if (!reviewed) problems.push(`${rel}: ${count} raw submit button(s); use SubmitButton`);
    else if (count > reviewed.count) problems.push(`${rel}: ${count} raw submit buttons, ${reviewed.count} reviewed (${reviewed.why})`);
  }
  for (const rel of Object.keys(RAW_SUBMIT_REVIEWED)) {
    if (!seen.has(rel)) problems.push(`${rel}: reviewed but has no raw submit button now; remove it from the list`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** Every source file, server actions included. */
function allSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allSources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test("every action that runs once has a form that sends its request id", () => {
  const claimed = new Set<string>();
  const sent = new Set<string>();
  for (const file of allSources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/runOnce\(\s*formData,\s*"([^"]+)"/g)) claimed.add(m[1]);
    for (const m of text.matchAll(/<RequestIdInput action=\{?([^}/]+?)\}? \/>/g)) {
      for (const name of m[1].matchAll(/"([^"]+)"/g)) sent.add(name[1]);
    }
    // A shared form that takes the name as a prop (OrderForm requestAction="orders:create").
    for (const m of text.matchAll(/requestAction="([^"]+)"/g)) sent.add(m[1]);
  }
  assert.ok(claimed.size >= 20, `expected the runOnce actions to be found, found ${claimed.size}`);
  const unsent = [...claimed].filter((name) => !sent.has(name));
  assert.deepEqual(unsent, [], `runOnce actions with no form sending a RequestIdInput (the guard never engages):\n${unsent.join("\n")}`);
});

test("the service worker lets DownloadLink's requests through to the server", () => {
  const worker = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
  assert.ok(
    worker.includes(`request.headers.get("${DOWNLOAD_HEADER}") === "1"`),
    `public/sw.js must skip requests carrying ${DOWNLOAD_HEADER}, or a download is answered from its cache`,
  );
  assert.ok(/!isAttachment\(res\)/.test(worker), "public/sw.js must not cache a file response under a page URL");
});
