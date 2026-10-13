import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ID_CHUNK, PAGE_ROWS, readAll, readByIds, type Pageable } from "./read-all";
import { PAGE_SIZE, pageNumber, pageRange } from "@/lib/paging";

/** A fake table of `total` rows that records every request made of it. */
function fakeTable(total: number, failAt?: number) {
  const calls: { order: [string, boolean | undefined][]; from: number; to: number }[] = [];
  let built = 0;
  const query = (): Pageable => {
    built += 1;
    const order: [string, boolean | undefined][] = [];
    const builder: Pageable = {
      order(column, options) {
        order.push([column, options?.ascending]);
        return builder;
      },
      range(from, to) {
        calls.push({ order, from, to });
        if (failAt !== undefined && from >= failAt) {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        const rows = [];
        for (let i = from; i <= Math.min(to, total - 1); i += 1) rows.push({ id: i });
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return builder;
  };
  return { query, calls, built: () => built };
}

test("readAll reads past the API's thousand rows, a fresh query per page, ordered by id", async () => {
  const t = fakeTable(2_500);
  const result = await readAll<{ id: number }>(t.query);
  assert.equal(result.error, null);
  assert.equal(result.truncated, false);
  assert.equal(result.data?.length, 2_500);
  assert.deepEqual(result.data?.slice(998, 1002).map((r) => r.id), [998, 999, 1000, 1001]);
  assert.deepEqual(t.calls.map((c) => [c.from, c.to]), [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.equal(t.built(), 3);
  for (const c of t.calls) assert.deepEqual(c.order, [["id", true]]);
});

test("readAll stops after one request when the first page is short", async () => {
  const t = fakeTable(3);
  const result = await readAll(t.query);
  assert.equal(result.data?.length, 3);
  assert.equal(t.calls.length, 1);
});

test("readAll makes one more request when the rows end exactly on a page", async () => {
  const t = fakeTable(PAGE_ROWS);
  const result = await readAll(t.query);
  assert.equal(result.data?.length, PAGE_ROWS);
  assert.equal(result.truncated, false);
  assert.equal(t.calls.length, 2);
});

test("readAll returns the error and no rows when any page fails", async () => {
  const t = fakeTable(5_000, 2_000);
  const result = await readAll(t.query);
  assert.equal(result.data, null);
  assert.deepEqual(result.error, { message: "boom" });
});

test("readAll honours a ceiling and says the read was cut", async () => {
  const t = fakeTable(5_000);
  const result = await readAll(t.query, { maxRows: 1_500 });
  assert.equal(result.data?.length, 1_500);
  assert.equal(result.truncated, true);
  assert.deepEqual(t.calls.map((c) => [c.from, c.to]), [[0, 999], [1000, 1499]]);
});

test("readAll sorts by the key it is given", async () => {
  const t = fakeTable(10);
  await readAll(t.query, { key: "machine_id" });
  assert.deepEqual(t.calls[0].order, [["machine_id", true]]);
});

test("readByIds asks a hundred ids at a time, once each, and nothing for none", async () => {
  const chunks: string[][] = [];
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
  const result = await readByIds<{ id: string }>([...ids, "id-0", "id-1"], (chunk) => {
    chunks.push(chunk);
    return {
      order() { return this; },
      range() { return Promise.resolve({ data: chunk.map((id) => ({ id })), error: null }); },
    };
  });
  assert.deepEqual(chunks.map((c) => c.length), [ID_CHUNK, ID_CHUNK, 50]);
  assert.equal(result.data?.length, 250);
  assert.equal(new Set(result.data?.map((r) => r.id)).size, 250);

  let asked = false;
  const none = await readByIds([], () => {
    asked = true;
    throw new Error("must not be called");
  });
  assert.equal(asked, false);
  assert.deepEqual(none.data, []);
});

test("page numbers and ranges", () => {
  assert.equal(pageNumber(undefined), 1);
  assert.equal(pageNumber("abc"), 1);
  assert.equal(pageNumber("-4"), 1);
  assert.equal(pageNumber("3.7"), 3);
  assert.equal(pageNumber("99999"), 10000);
  // One row more than a page: the extra row only says an older page exists.
  assert.deepEqual(pageRange(1), [0, PAGE_SIZE]);
  assert.deepEqual(pageRange(3, 20), [40, 60]);
});

// == The guard ==================================================================
//
// Every read of a table that grows with use must be capped (.limit, .range, one row) or
// paged (readAll, readByIds, the assistant's paged()). The API stops at a thousand rows
// without an error, so an uncapped read of these tables is a total, export or list that is
// silently wrong for a large enough farm. A read that is bounded by what it reads (the
// lines of one document, one machine on one day) is listed below with the reason; so is a
// query factory whose every use is capped or paged.
//
// When this fails on a new read: wrap it in readAll(() => query) or page it with .range().
// Only if it truly cannot grow, add it below with the reason.

const GROWING = [
  "fuel_issues", "fuel_deliveries", "cost_entries", "job_cards", "job_card_lines", "meter_readings",
  "faults", "work_requests", "work_request_events", "usage_logs", "stock_movements", "checklist_instances",
  "ai_interactions", "notifications", "attachments", "bank_lines", "partner_expenses", "partner_documents",
  "partner_document_lines", "partner_payments", "audit_log", "voice_captures", "fines", "incidents",
  "service_plan_lines", "licences", "purchase_orders", "purchase_order_lines", "warranty_claims",
  "billing_invoices", "billing_payment_attempts", "ai_usage_events", "ai_health_events",
];

/** Functions that return a row per event, so a big enough farm passes a thousand rows. */
const GROWING_RPCS = [
  "farm_journal", "partner_journal", "partner_statement", "supplier_statement", "tyre_life",
  "cron_run_due_report_schedules",
];

const BOUNDED: Record<string, string> = {
  "src/lib/accounting-read.ts|farm_journal": "the second arm of readJournal's ternary, inside its readAll",
  "src/app/(app)/documents/actions.ts|partner_document_lines": "the lines of one document",
  "src/app/(app)/documents/[id]/page.tsx|partner_document_lines": "the lines of one document",
  "src/app/(app)/documents/[id]/page.tsx|partner_payments": "the payments against one document",
  "src/app/(app)/documents/[id]/page.tsx|partner_documents": "the credit notes raised against one invoice",
  "src/app/(app)/driver/page.tsx|faults": "myReports(): every caller adds .limit",
  "src/app/(app)/expenses/page.tsx|partner_expenses": "listQuery(): the factory ends in .limit(LIST_ROWS)",
  "src/app/(app)/faults/page.tsx|faults": "faultQuery(): every caller adds .range or .limit",
  "src/app/(app)/faults/page.tsx|work_requests": "for the faults on one page",
  "src/app/(app)/faults/page.tsx|attachments": "the photos of the faults on one page",
  "src/app/(app)/fines/page.tsx|fines": "finesQuery(): read through readAll, or one .range page",
  "src/app/(app)/fines/page.tsx|usage_logs": "one vehicle on one day",
  "src/app/(app)/incidents/page.tsx|incidents": "incidentsQuery(): read through readAll, or one .range page",
  "src/app/(app)/jobcards/page.tsx|job_cards": "jobCards(): read through readAll, or one .range page",
  "src/app/(app)/jobcards/[id]/page.tsx|job_card_lines": "the lines of one job card",
  "src/app/(app)/jobcards/[id]/page.tsx|service_plan_lines": "one machine's service plan",
  "src/app/(app)/jobcards/[id]/page.tsx|attachments": "the photos of one job card",
  "src/app/(app)/jobcards/[id]/page.tsx|cost_entries": "the invoice entries of one job card",
  "src/app/(app)/jobcards/[id]/pdf/route.ts|job_card_lines": "the lines of one job card",
  "src/app/(app)/machines/page.tsx|service_plan_lines": "planQ(): read through readAll",
  "src/app/(app)/machines/[id]/file.pdf/route.ts|service_plan_lines": "one machine's service plan",
  "src/app/(app)/machines/[id]/page.tsx|service_plan_lines": "one machine's service plan",
  "src/app/(app)/machines/[id]/page.tsx|licences": "one machine's licences",
  "src/app/(app)/machines/[id]/page.tsx|usage_logs": "one machine on one day",
  "src/app/(app)/orders/actions.ts|purchase_order_lines": "the lines of one order",
  "src/app/(app)/orders/[id]/page.tsx|purchase_order_lines": "the lines of one order",
  "src/app/(app)/work/page.tsx|work_requests": "requests(): read through readAll, or one .range page",
  "src/app/(app)/work/[id]/page.tsx|work_request_events": "the events of one request",
  "src/app/(app)/work/[id]/page.tsx|attachments": "the photos of one request",
  "src/app/(app)/work/[id]/page.tsx|partner_documents": "the documents of one request",
  "src/components/machine-photos.tsx|attachments": "one machine's photos",
  "src/lib/document-load.ts|partner_documents": "one document (maybeSingle on the next line)",
  "src/lib/document-load.ts|partner_document_lines": "the lines of one document",
  "src/lib/pdf/pack-data.ts|attachments": "one machine's photos",
};

const READ = new RegExp(`\\.(?:from|rpc)\\((?:operational\\()?"(${[...GROWING, ...GROWING_RPCS].join("|")})(?:_visible)?"`, "g");
const CAPPED = /p_limit:|\.limit\(|\.range\(|\.single\(\)|\.maybeSingle\(\)|head:\s*true|\.eq\("id",|\.in\("id",|\.insert\(|\.update\(|\.delete\(|\.upsert\(/;
const PAGED = /\b(?:readAll|readByIds|paged)(?:<[^>()]*>)?\(/;
const STATEMENT_ENDS = [";\n", "\n\n", ".from(", ".rpc(", "]);"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Each read of a growing table in `text` with no cap and no paging: its table and line. */
function uncappedIn(text: string): { table: string; line: number }[] {
  const out: { table: string; line: number }[] = [];
  for (const match of text.matchAll(READ)) {
    const at = match.index ?? 0;
    let end = text.length;
    for (const stop of STATEMENT_ENDS) {
      const i = text.indexOf(stop, at + 6);
      if (i !== -1 && i < end) end = i;
    }
    if (CAPPED.test(text.slice(at, end))) continue;
    // Paged when the call that wraps it opens after the previous query, not before it.
    let before = text.slice(Math.max(0, at - 300), at);
    const previous = Math.max(before.lastIndexOf(".from("), before.lastIndexOf(".rpc("));
    if (previous !== -1) before = before.slice(previous + 6);
    if (PAGED.test(before)) continue;
    out.push({ table: match[1], line: text.slice(0, at).split("\n").length });
  }
  return out;
}

/** `file|table` for every read of a growing table under src/ with no cap and no paging. */
function uncappedReads(): Map<string, number[]> {
  const src = fileURLToPath(new URL("../..", import.meta.url));
  const repo = join(src, "..");
  const found = new Map<string, number[]>();
  for (const file of sources(src)) {
    for (const { table, line } of uncappedIn(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))) {
      const key = `${relative(repo, file).replace(/\\/g, "/")}|${table}`;
      found.set(key, [...(found.get(key) ?? []), line]);
    }
  }
  return found;
}

test("no uncapped read of a table that grows with use", () => {
  const found = uncappedReads();
  const unexpected = [...found].filter(([key]) => !(key in BOUNDED));
  assert.deepEqual(
    unexpected.map(([key, lines]) => `${key} (line ${lines.join(", ")})`),
    [],
    "These reads can silently stop at the API's thousandth row. Wrap each in readAll(() => query) " +
      "from @/lib/supabase/read-all, page it with .range(), or (only if it truly cannot grow) list it " +
      "in BOUNDED with the reason.",
  );
});

test("every bounded read listed still exists, so the list stays honest", () => {
  const found = uncappedReads();
  const stale = Object.keys(BOUNDED).filter((key) => !found.has(key));
  assert.deepEqual(stale, [], "Remove these from BOUNDED: the read is gone or is now capped or paged.");
});

test("the guard flags an uncapped read, and not a capped, paged or single-row one", () => {
  const sample = [
    `const a = await supabase.from("fuel_issues").select("litres").limit(10);`,
    `const b = await readAll(() => supabase.from("fuel_issues").select("litres"));`,
    `const c = await supabase.from("fuel_issues_visible").select("litres");`,
    `const d = await supabase.from("faults").select("id").eq("id", x).maybeSingle();`,
    // A readAll that wraps the PREVIOUS query must not excuse this one.
    `const [e, f] = await Promise.all([readAll(() => supabase.from("faults").select("id")), supabase.from("cost_entries").select("amount_cents")]);`,
    "",
  ].join("\n");
  assert.deepEqual(uncappedIn(sample), [
    { table: "fuel_issues", line: 3 },
    { table: "cost_entries", line: 5 },
  ]);
});
