/**
 * The complete export job (BRIEF scenario 29, and 20 for what never leaves): records read page
 * by page through the requester's session into numbered parts that continue across steps, a
 * table the person may not read named rather than emptied, the cutoff, files copied once with
 * retries and a missing-file reason, chat refused before any read, parts kept to their size, the
 * lease, and the worker's re-check. A small in-memory stand-in plays Supabase.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildManifest, exportObjectPath, fileEntryName, missingReason, partName, recordsEntryName, zipPart } from "./archive";
import { filesStep, recordsStep, runExportStep, type ExportJob } from "./job";
import { EXPORT_TABLES, NEVER_EXPORTED } from "./tables";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_KEEP_DAYS, EXPORTS_PER_DAY } from "@/lib/limits";

const MIGRATION = readFileSync(join(import.meta.dirname, "../../../supabase/migrations/20261120110000_complete_export.sql"), "utf8");

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** Just enough of the client: filters, order, limit/range, insert, update, delete, rpc, storage. */
function fakeClient(opts: {
  tables?: Record<string, Row[]>;
  refuse?: string[];
  noCreatedAt?: string[];
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>;
  files?: Record<string, Uint8Array | { status: number; message: string }>;
}) {
  const tables = opts.tables ?? {};
  const stored = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const builder = (name: string) => {
    const filters: Filter[] = [];
    let order: string[] = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let patch: Row = {};
    let insertRows: Row[] = [];
    let failure: { code: string; message: string } | null = null;
    let single = false;
    const run = () => {
      if (failure) return { data: null, error: failure };
      if ((opts.refuse ?? []).includes(name)) return { data: null, error: { code: "42501", message: "permission denied" } };
      const rows = (tables[name] ??= []);
      if (mode === "insert") {
        rows.push(...insertRows);
        return { data: insertRows, error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit, error: null };
      }
      if (mode === "delete") {
        tables[name] = rows.filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      for (const key of [...order].reverse()) hit = [...hit].sort((a, b) => String(a[key]).localeCompare(String(b[key]), "en", { numeric: true }));
      if (range) hit = hit.slice(range[0], range[1] + 1);
      if (limit != null) hit = hit.slice(0, limit);
      return { data: single ? (hit[0] ?? null) : hit.map((r) => ({ ...r })), error: null };
    };
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), api),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), api),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), api),
      gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), api),
      lte: (c: string, v: string) => {
        if ((opts.noCreatedAt ?? []).includes(name) && c === "created_at") failure = { code: "42703", message: `column ${name}.created_at does not exist` };
        filters.push((r) => r[c] == null || String(r[c]) <= v);
        return api;
      },
      order: (c: string) => (order.push(c), api),
      limit: (n: number) => ((limit = n), api),
      range: (a: number, b: number) => ((range = [a, b]), api),
      update: (p: Row) => ((mode = "update"), (patch = p), api),
      insert: (rows: Row[]) => ((mode = "insert"), (insertRows = rows), api),
      delete: () => ((mode = "delete"), api),
      maybeSingle: () => ((single = true), api),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return api;
  };
  const client = {
    from: builder,
    rpc: (fn: string, args: Record<string, unknown>) => {
      const handler = opts.rpc?.[fn];
      const value = handler ? handler(args) : null;
      const result = { data: value, error: null };
      return Object.assign(Promise.resolve(result), { maybeSingle: () => Promise.resolve(result) });
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Uint8Array) => (stored.set(`${bucket}/${path}`, bytes), { data: {}, error: null }),
        download: async (path: string) => {
          reads.push(`${bucket}/${path}`);
          const f = opts.files?.[`${bucket}/${path}`];
          if (!f) return { data: null, error: { status: 404, message: "Object not found" } };
          if (!(f instanceof Uint8Array)) return { data: null, error: f };
          return { data: new Blob([f as BlobPart]), error: null };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, tables, stored, reads };
}

const FARM = "a1000000-0000-4000-9000-000000000001";
const JOB = "a2000000-0000-4000-9000-000000000001";
const job = (over: Partial<ExportJob> = {}): ExportJob => ({
  id: JOB, farm_id: FARM, requested_by: "a3000000-0000-4000-9000-000000000001", requester_role: "owner",
  status: "records", cutoff_at: "2026-11-18T10:00:00.000Z", inventory_done: true, files_capped: false,
  records_cursor: {}, tables: [], parts: [], files_total: 0, files_done: 0, files_missing: 0, bytes_total: 0,
  bytes_done: 0, manifest_sha256: null, last_error: null, ready_at: null, expires_at: null, removed_at: null,
  created_at: "2026-11-18T10:00:00.000Z", updated_at: "2026-11-18T10:00:00.000Z", ...over,
});
const id = (n: number) => `b0000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

test("nothing private is in the table list: no staff chat, command audio, ledgers or card details", () => {
  assert.deepEqual(EXPORT_TABLES.filter((t) => NEVER_EXPORTED.test(t.name) || NEVER_EXPORTED.test(t.source ?? "")), []);
  assert.ok(EXPORT_TABLES.some((t) => t.name === "storage_charges") && EXPORT_TABLES.some((t) => t.name === "storage_usage_snapshots"));
});

test("records: page by page through the session, parts that continue across steps, the cutoff, and unreadable tables named", async () => {
  const machines = Array.from({ length: 1500 }, (_, i) => ({ id: id(i + 1), farm_id: FARM, name: `M${i}`, created_at: "2026-11-01T00:00:00Z" }));
  machines.push({ id: id(9999), farm_id: FARM, name: "made after the cutoff", created_at: "2026-11-19T00:00:00Z" });
  const session = fakeClient({
    tables: {
      farms: [{ id: FARM, name: "Yard", created_at: "2026-01-01T00:00:00Z" }],
      machines,
      service_plan_lines: [{ id: id(1), farm_id: FARM, task: "Oil" }],
    },
    refuse: ["budgets"],
    noCreatedAt: ["service_plan_lines"],
    rpc: { can_view_farm_costs: () => false },
  });
  const svc = fakeClient({ tables: { farm_export_jobs: [{ id: JOB, lease_token: "t" }] } });
  // A tiny part size: the first step stops after the first page of machines.
  await recordsStep(session.client, svc.client, job(), "t", Date.now() + 60_000, 1);
  const saved = svc.tables.farm_export_jobs[0] as Row & { parts: { n: number }[]; records_cursor: { t: number; chunk: number; after: string } };
  assert.equal(saved.status, "records");
  assert.equal(saved.parts.length, 1);
  assert.ok(svc.stored.has(`farm-exports/${exportObjectPath(FARM, JOB, partName(1))}`));

  // Carry on from where it stopped until the records are done.
  for (let i = 0; i < 10 && svc.tables.farm_export_jobs[0].status === "records"; i += 1) {
    const next = svc.tables.farm_export_jobs[0] as unknown as ExportJob;
    await recordsStep(session.client, svc.client, job({ records_cursor: next.records_cursor, tables: next.tables, parts: next.parts }), "t", Date.now() + 60_000, 1);
  }
  const done = svc.tables.farm_export_jobs[0] as unknown as ExportJob;
  assert.equal(done.status, "finishing", "no files: straight to the manifest");
  const meta = (name: string) => done.tables.find((t) => t.name === name);
  assert.equal(meta("machines")?.rows, 1500, "every machine once, none created after the cutoff");
  assert.equal(meta("machines")?.cutoff, "created_at");
  assert.equal(meta("service_plan_lines")?.cutoff, "none", "a table without a creation time is read whole and says so");
  assert.equal(meta("service_plan_lines")?.rows, 1);
  assert.equal(meta("budgets")?.status, "unavailable", "a table the person may not read is named, not emptied");
  assert.equal(done.tables.length, EXPORT_TABLES.length);
  // Machines span two parts as two chunks, never one name twice.
  assert.ok(done.parts.length >= 3);
});

test("records need the lease: a step whose lease was taken over writes nothing", async () => {
  const session = fakeClient({ tables: { farms: [{ id: FARM, created_at: "2026-01-01" }] }, rpc: { can_view_farm_costs: () => false } });
  const svc = fakeClient({ tables: { farm_export_jobs: [{ id: JOB, lease_token: "someone-else" }] } });
  await assert.rejects(recordsStep(session.client, svc.client, job(), "t", Date.now() + 60_000), /lease lost/);
});

test("files: copied once with a checksum, retried, then missing with a reason; chat refused before any read; parts bounded", async () => {
  const bytes = new TextEncoder().encode("photo-bytes");
  const inventory = [
    { job_id: JOB, seq: 1, bucket: "machine-photos", name: `${FARM}/a.jpg`, size: 11, attempts: 0, status: "pending" },
    { job_id: JOB, seq: 2, bucket: "chat-files", name: `${FARM}/private.ogg`, size: 5, attempts: 0, status: "pending" },
    { job_id: JOB, seq: 3, bucket: "machine-docs", name: `${FARM}/gone.pdf`, size: 7, attempts: 2, status: "pending" },
    { job_id: JOB, seq: 4, bucket: "machine-docs", name: `${FARM}/flaky.pdf`, size: 7, attempts: 0, status: "pending" },
    { job_id: JOB, seq: 5, bucket: "machine-photos", name: `${FARM}/b.jpg`, size: 11, attempts: 0, status: "pending" },
  ];
  type Recorded = { p_part: { n: number; entries: number; sha256: string } | null; p_rows: Row[] };
  const seen: { value: Recorded | null } = { value: null };
  const svc = fakeClient({
    tables: { farm_export_job_files: inventory },
    rpc: { export_job_record_files: (args) => ((seen.value = args as unknown as Recorded), null) },
  });
  const session = fakeClient({
    files: {
      [`machine-photos/${FARM}/a.jpg`]: bytes,
      [`machine-photos/${FARM}/b.jpg`]: bytes,
      [`machine-docs/${FARM}/flaky.pdf`]: { status: 500, message: "timeout" },
    },
  });
  const reader = async (bucket: string, path: string) => {
    const { data, error } = await session.client.storage.from(bucket).download(path);
    return data ? { bytes: new Uint8Array(await data.arrayBuffer()) } : { error: error as { message?: string; status?: number } };
  };
  // A part of 20 bytes: a.jpg (11) fits, b.jpg (11) would pass it and waits for the next part.
  await filesStep(svc.client, reader, job({ status: "files" }), "t", Date.now() + 60_000, 20);
  const recorded = seen.value;
  assert.ok(recorded);
  const rows = new Map((recorded.p_rows as Row[]).map((r) => [r.seq, r]));
  assert.equal(rows.get(1)?.status, "copied");
  assert.match(String(rows.get(1)?.sha256), /^[0-9a-f]{64}$/);
  assert.equal(rows.get(1)?.archive_path, fileEntryName("machine-photos", `${FARM}/a.jpg`, FARM));
  assert.equal(rows.get(2)?.status, "missing", "chat is refused");
  assert.ok(!session.reads.some((r) => r.startsWith("chat-files")), "and never read");
  assert.deepEqual([rows.get(3)?.status, rows.get(3)?.reason], ["missing", "not_found"], "the third failed attempt reports it missing");
  assert.equal(rows.get(4)?.status, undefined, "a failure with attempts left stays pending");
  assert.equal(rows.get(4)?.attempted, 1);
  assert.ok(!rows.has(5), "the file that would pass the part size waits for the next part");
  assert.equal(recorded.p_part?.n, 1);
  assert.equal(recorded.p_part?.entries, 1);
  assert.ok(svc.stored.has(`farm-exports/${exportObjectPath(FARM, JOB, "part-0001.zip")}`));
});

test("a step already running is left alone, and the worker stops a job its requester may no longer take", async () => {
  const busy = fakeClient({ rpc: { export_job_claim: () => null } });
  assert.deepEqual(await runExportStep(busy.client, null, JOB, 1000), { status: "busy" });

  const svc = fakeClient({
    tables: { farm_export_jobs: [{ ...job({ status: "files" }), lease_token: "lease" }] },
    rpc: { export_job_claim: () => "lease", export_job_allowed: () => false, export_job_release: () => null },
  });
  const outcome = await runExportStep(svc.client, null, JOB, 1000);
  assert.equal(outcome.status, "failed");
  assert.equal(svc.tables.farm_export_jobs[0].last_error, "access ended");

  const records = fakeClient({
    tables: { farm_export_jobs: [{ ...job({ status: "records" }), lease_token: "lease" }] },
    rpc: { export_job_claim: () => "lease", export_job_allowed: () => true, export_job_release: () => null },
  });
  assert.equal((await runExportStep(records.client, null, JOB, 1000)).status, "needs-session", "records are read only with the requester's session");
});

test("archive names are portable and scoped; the manifest states scope and omissions without restricted content", async () => {
  assert.equal(partName(12), "part-0012.zip");
  assert.equal(recordsEntryName("machines", 2), "records/machines.2.ndjson");
  assert.throws(() => recordsEntryName("../etc", 1));
  assert.throws(() => exportObjectPath(FARM, JOB, "../x"));
  assert.throws(() => fileEntryName("chat-files", `${FARM}/x.ogg`, FARM));
  assert.throws(() => fileEntryName("farm-exports", `${FARM}/x.zip`, FARM));
  assert.throws(() => fileEntryName("machine-photos", "other-farm/x.jpg", FARM));
  assert.match(fileEntryName("machine-photos", `${FARM}/../../evil name.jpg`, FARM), /^files\/machine-photos\/[0-9a-f]{64}-evil_name\.jpg$/);
  assert.equal(missingReason({ status: 404, message: "Object not found" }), "not_found");
  assert.equal(missingReason({ status: 403, message: "denied" }), "refused");
  assert.equal(missingReason({ message: "socket hang up" }), "error");

  const manifest = buildManifest({
    jobId: JOB, farmId: FARM, requestedBy: "u", role: "manager", cutoffAt: "c", generatedAt: "g",
    tables: [{ name: "machines", rows: 2, status: "ok", cutoff: "created_at" }, { name: "finance_agreements", rows: 0, status: "unavailable", cutoff: "none" }],
    parts: [{ n: 1, name: "part-0001.zip", bytes: 10, sha256: "a".repeat(64), entries: 2, kind: "records" }],
    files: [{ archive_path: "files/x", bucket: "machine-photos", size: 5, sha256: "b".repeat(64), part: 1 }],
    missing: [{ bucket: "machine-docs", name: `${FARM}/secret-contract.pdf`, reason: "refused" }],
    filesCapped: false,
  });
  assert.equal(manifest.counts.rows, 2);
  assert.equal(manifest.counts.missing_files, 1);
  assert.ok(manifest.omitted.some((line) => /chat/i.test(line)));
  assert.ok(manifest.omitted.some((line) => line.includes("finance_agreements")));
  assert.ok(!JSON.stringify(manifest).includes("secret-contract"), "a missing file is named by a hash, never by its key");

  const zip = await zipPart([{ name: "records/a.1.ndjson", bytes: new TextEncoder().encode("{}\n") }]);
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x04034b50);
});

test("the database's daily limit and keeping time are the catalogue's", () => {
  assert.ok(MIGRATION.includes(`= v_today) >= ${EXPORTS_PER_DAY} then`), "export_job_create counts the catalogue's daily limit");
  assert.ok(MIGRATION.includes(`v_expires timestamptz := now() + interval '${EXPORT_KEEP_DAYS} days';`), "export_job_finish keeps the catalogue's days");
});
