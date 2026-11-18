import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { canViewFarmCosts, readMachineFinancials } from "@/lib/cost-visibility";
import { captureError } from "@/lib/observability";
import { PAGE_ROWS } from "@/lib/supabase/read-all";

import {
  EXPORT_BUCKET, FILE_ATTEMPTS, MAX_FILES, PART_TARGET_BYTES, buildManifest, exportObjectPath, fileEntryName,
  missingReason, partName, recordsEntryName, sha256Hex, zipPart,
  type FileEntry, type MissingEntry, type PartMeta, type TableMeta,
} from "./archive";
import { EXPORT_TABLES, type ExportTable } from "./tables";

/**
 * The complete export job (20261120110000), in bounded steps.
 *
 * RECORDS are read with the requester's own session, page by page, exactly as the streamed
 * export reads them (row security decides every row), and written as numbered ZIP parts.
 * FILES are the authorised inventory taken with the requester's session at the start; their
 * bytes are read through that session when the requester's page drives the step, or by the
 * nightly worker with the service role after `export_job_allowed` says the requester may still
 * export. Every step holds the job's lease and records what it did only after its part is
 * stored; a part is named by its number and stored with upsert, so a step that dies between the
 * two is repeated onto the same object rather than duplicating anything.
 */

export const JOB_COLUMNS =
  "id, farm_id, requested_by, requester_role, status, cutoff_at, inventory_done, files_capped, records_cursor, tables, " +
  "parts, files_total, files_done, files_missing, bytes_total, bytes_done, manifest_sha256, last_error, ready_at, expires_at, " +
  "removed_at, created_at, updated_at";

/** What the requester's page reads: never the cursor or the lease. */
export const PUBLIC_JOB_COLUMNS =
  "id, farm_id, status, cutoff_at, inventory_done, files_capped, tables, parts, files_total, files_done, files_missing, " +
  "bytes_total, bytes_done, last_error, ready_at, expires_at, removed_at, created_at";

export type ExportJob = {
  id: string;
  farm_id: string;
  requested_by: string;
  requester_role: string;
  status: "records" | "files" | "finishing" | "ready" | "failed" | "expired" | "cancelled";
  cutoff_at: string;
  inventory_done: boolean;
  files_capped: boolean;
  records_cursor: Cursor;
  tables: TableMeta[];
  parts: PartMeta[];
  files_total: number;
  files_done: number;
  files_missing: number;
  bytes_total: number;
  bytes_done: number;
  manifest_sha256: string | null;
  last_error: string | null;
  ready_at: string | null;
  expires_at: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Where the records phase stands: the table, the last key (or offset) and its chunk. */
export type Cursor = { t?: number; after?: string | null; offset?: number; chunk?: number; filter?: "created_at" | "none" | null };

/** A table's rows past this are left out and the manifest says so. Time is spread over steps. */
export const ROW_CAP = 1_000_000;

export type FileReader = (bucket: string, path: string) => Promise<{ bytes: Uint8Array } | { error: { message?: string; status?: number } }>;

export function sessionReader(session: SupabaseClient): FileReader {
  return async (bucket, path) => {
    const { data, error } = await session.storage.from(bucket).download(path);
    if (error || !data) return { error: (error as { message?: string; status?: number } | null) ?? { message: "empty" } };
    return { bytes: new Uint8Array(await data.arrayBuffer()) };
  };
}

/** Only for the worker, only for the inventory the requester's session listed. */
export function serviceReader(svc: SupabaseClient): FileReader {
  return sessionReader(svc);
}

async function readJob(svc: SupabaseClient, id: string): Promise<ExportJob> {
  const { data, error } = await svc.from("farm_export_jobs").select(JOB_COLUMNS).eq("id", id).maybeSingle();
  if (error || !data) throw error ?? new Error("export: job gone");
  return data as unknown as ExportJob;
}

/** Saves under the lease; a step whose lease was taken over writes nothing. */
async function saveJob(svc: SupabaseClient, id: string, token: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await svc
    .from("farm_export_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("lease_token", token)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("export: lease lost");
}

async function storeObject(svc: SupabaseClient, path: string, bytes: Uint8Array, type: string): Promise<void> {
  const { error } = await svc.storage.from(EXPORT_BUCKET).upload(path, bytes, { contentType: type, upsert: true });
  if (error) throw error;
}

/** The files the requester may read at the cutoff, listed with their own session. */
export async function takeInventory(session: SupabaseClient, svc: SupabaseClient, job: ExportJob, token: string): Promise<void> {
  if (job.inventory_done) return;
  // Start again rather than resume a half-written list: listing is quick and this keeps the
  // totals exact.
  const { error: clearError } = await svc.from("farm_export_job_files").delete().eq("job_id", job.id);
  if (clearError) throw clearError;
  let afterBucket: string | null = null;
  let afterName: string | null = null;
  let seq = 0;
  let bytes = 0;
  let capped = false;
  for (;;) {
    const listed: { data: unknown; error: unknown } = await session.rpc("export_readable_files", {
      p_farm: job.farm_id, p_after_bucket: afterBucket, p_after_name: afterName, p_limit: PAGE_ROWS,
    });
    if (listed.error) throw listed.error;
    type Listed = { bucket_id: string; name: string; size: number };
    let rows: Listed[] = (listed.data as Listed[] | null) ?? [];
    if (rows.length === 0) break;
    if (seq + rows.length > MAX_FILES) {
      rows = rows.slice(0, MAX_FILES - seq);
      capped = true;
    }
    const insert = rows.map((r: Listed) => {
      seq += 1;
      bytes += Number(r.size) || 0;
      return { job_id: job.id, farm_id: job.farm_id, seq, bucket: r.bucket_id, name: r.name, size: Number(r.size) || 0 };
    });
    if (insert.length) {
      const { error: insertError } = await svc.from("farm_export_job_files").insert(insert);
      if (insertError) throw insertError;
    }
    const last: Listed | undefined = rows[rows.length - 1];
    afterBucket = last?.bucket_id ?? afterBucket;
    afterName = last?.name ?? afterName;
    if (capped || rows.length < PAGE_ROWS) break;
  }
  await saveJob(svc, job.id, token, { inventory_done: true, files_total: seq, bytes_total: bytes, files_capped: capped });
}

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === "42703" || /column .*created_at.* does not exist/i.test(error.message ?? ""));
}

async function readPage(session: SupabaseClient, spec: ExportTable, farmId: string, cursor: Cursor, cutoff: string) {
  const key = spec.key ?? "id";
  const build = (withCutoff: boolean) => {
    let q = session.from(spec.source ?? spec.name).select(spec.columns ?? "*").eq(spec.farmColumn ?? "farm_id", farmId);
    if (withCutoff) q = q.lte("created_at", cutoff);
    if (key === "id") {
      if (cursor.after) q = q.gt("id", cursor.after);
      return q.order("id", { ascending: true }).limit(PAGE_ROWS);
    }
    const from = cursor.offset ?? 0;
    const ordered = spec.order ? q.order(spec.order, { ascending: true }) : q;
    return ordered.order(key, { ascending: true }).range(from, from + PAGE_ROWS - 1);
  };
  if (cursor.filter == null) {
    const first = await build(true);
    if (!first.error) {
      cursor.filter = "created_at";
      return { rows: (first.data ?? []) as unknown as Record<string, unknown>[] };
    }
    if (!isMissingColumn(first.error)) return { unavailable: true as const };
    cursor.filter = "none";
  }
  const res = await build(cursor.filter === "created_at");
  if (res.error) return { error: res.error };
  return { rows: (res.data ?? []) as unknown as Record<string, unknown>[] };
}

/** One records step: tables from the cursor until a part's worth or the time is up. */
export async function recordsStep(
  session: SupabaseClient, svc: SupabaseClient, job: ExportJob, token: string, deadline: number,
  partBytes: number = PART_TARGET_BYTES,
): Promise<void> {
  const cursor: Cursor = { t: 0, after: null, offset: 0, chunk: 1, filter: null, ...(job.records_cursor ?? {}) };
  const tables: TableMeta[] = [...(job.tables ?? [])];
  const costsVisible = await canViewFarmCosts(session, job.farm_id);
  const chunks = new Map<string, { table: string; chunk: number; text: string[] }>();
  let size = 0;
  let t = cursor.t ?? 0;
  while (t < EXPORT_TABLES.length && Date.now() < deadline && size < partBytes) {
    const spec = EXPORT_TABLES[t];
    const meta = tables[t] ?? (tables[t] = { name: spec.name, rows: 0, status: "ok", cutoff: "none" });
    const page = await readPage(session, spec, job.farm_id, cursor, job.cutoff_at);
    if ("unavailable" in page || ("error" in page && meta.rows === 0)) {
      // A table this person may not read at all, or one this deployment does not have.
      meta.status = "unavailable";
      t += 1;
      Object.assign(cursor, { t, after: null, offset: 0, chunk: 1, filter: null });
      continue;
    }
    if ("error" in page) throw new Error(`export: ${spec.name} failed part-way`);
    meta.cutoff = cursor.filter === "created_at" ? "created_at" : "none";
    const rows = page.rows ?? [];
    if (spec.name === "machines" && costsVisible) {
      for (let i = 0; i < rows.length; i += 10) {
        const batch = rows.slice(i, i + 10);
        const figures = await Promise.all(batch.map((m) => readMachineFinancials(session, String(m.id))));
        batch.forEach((m, j) => {
          const f = figures[j];
          if (!f) return;
          const money: Record<string, unknown> = { ...f };
          delete money.machine_id;
          delete money.farm_id;
          Object.assign(m, money);
        });
      }
    }
    if (rows.length) {
      const label = `${spec.name}:${cursor.chunk ?? 1}`;
      const entry = chunks.get(label) ?? { table: spec.name, chunk: cursor.chunk ?? 1, text: [] };
      for (const row of rows) {
        const line = `${JSON.stringify(row)}\n`;
        entry.text.push(line);
        size += line.length;
      }
      chunks.set(label, entry);
      meta.rows += rows.length;
      const last = rows[rows.length - 1];
      if ((spec.key ?? "id") === "id") cursor.after = String(last.id);
      else cursor.offset = (cursor.offset ?? 0) + rows.length;
    }
    if (rows.length < PAGE_ROWS || meta.rows >= ROW_CAP) {
      if (meta.rows >= ROW_CAP && rows.length === PAGE_ROWS) meta.status = "capped";
      t += 1;
      Object.assign(cursor, { t, after: null, offset: 0, chunk: 1, filter: null });
    }
  }
  const parts = [...(job.parts ?? [])];
  if (chunks.size) {
    const encoder = new TextEncoder();
    const entries = [...chunks.values()].map((c) => ({ name: recordsEntryName(c.table, c.chunk), bytes: encoder.encode(c.text.join("")) }));
    const bytes = await zipPart(entries);
    const n = parts.length + 1;
    await storeObject(svc, exportObjectPath(job.farm_id, job.id, partName(n)), bytes, "application/zip");
    parts.push({ n, name: partName(n), bytes: bytes.length, sha256: sha256Hex(bytes), entries: entries.length, kind: "records" });
    // The table this part stopped inside continues in its next chunk.
    if (t < EXPORT_TABLES.length && (cursor.after || cursor.offset)) cursor.chunk = (cursor.chunk ?? 1) + 1;
  }
  const done = t >= EXPORT_TABLES.length;
  await saveJob(svc, job.id, token, {
    records_cursor: { ...cursor, t },
    tables,
    parts,
    status: done ? (job.files_total > 0 ? "files" : "finishing") : "records",
    last_error: null,
  });
}

/** One files step: pending files in order until a part's worth or the time is up. */
export async function filesStep(
  svc: SupabaseClient, reader: FileReader, job: ExportJob, token: string, deadline: number,
  partBytes: number = PART_TARGET_BYTES,
): Promise<void> {
  const { data, error } = await svc
    .from("farm_export_job_files")
    .select("seq, bucket, name, size, attempts")
    .eq("job_id", job.id)
    .eq("status", "pending")
    .order("seq", { ascending: true })
    .limit(500);
  if (error) throw error;
  const pending = (data ?? []) as { seq: number; bucket: string; name: string; size: number; attempts: number }[];
  const n = (job.parts ?? []).length + 1;
  const entries: { name: string; bytes: Uint8Array }[] = [];
  const rows: Record<string, unknown>[] = [];
  let size = 0;
  for (const f of pending) {
    if (Date.now() > deadline) break;
    if (entries.length > 0 && size + Number(f.size) > partBytes) break;
    let name: string;
    try {
      name = fileEntryName(f.bucket, f.name, job.farm_id);
    } catch {
      rows.push({ seq: f.seq, status: "missing", reason: "refused", attempted: 1 });
      continue;
    }
    const got = await reader(f.bucket, f.name);
    if ("bytes" in got) {
      entries.push({ name, bytes: got.bytes });
      rows.push({ seq: f.seq, status: "copied", attempted: 1, archive_path: name, sha256: sha256Hex(got.bytes), part: n });
      size += got.bytes.length;
    } else if (f.attempts + 1 >= FILE_ATTEMPTS) {
      rows.push({ seq: f.seq, status: "missing", reason: missingReason(got.error), attempted: 1 });
    } else {
      rows.push({ seq: f.seq, attempted: 1 });
    }
  }
  let part: PartMeta | null = null;
  if (entries.length) {
    const bytes = await zipPart(entries);
    await storeObject(svc, exportObjectPath(job.farm_id, job.id, partName(n)), bytes, "application/zip");
    part = { n, name: partName(n), bytes: bytes.length, sha256: sha256Hex(bytes), entries: entries.length, kind: "files" };
  }
  const { error: recordError } = await svc.rpc("export_job_record_files", { p_job: job.id, p_token: token, p_part: part, p_rows: rows });
  if (recordError) throw recordError;
}

async function allRows<T>(svc: SupabaseClient, jobId: string, status: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await svc
      .from("farm_export_job_files")
      .select(columns)
      .eq("job_id", jobId)
      .eq("status", status)
      .order("seq", { ascending: true })
      .range(from, from + PAGE_ROWS - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE_ROWS) return out;
  }
}

/** The manifest, then ready: kept seven days at most and never past the owner's reading window. */
export async function finishJob(svc: SupabaseClient, job: ExportJob, token: string): Promise<void> {
  const files = await allRows<FileEntry>(svc, job.id, "copied", "archive_path, bucket, size, sha256, part");
  const missing = await allRows<MissingEntry>(svc, job.id, "missing", "bucket, name, reason");
  const manifest = buildManifest({
    jobId: job.id,
    farmId: job.farm_id,
    requestedBy: job.requested_by,
    role: job.requester_role,
    cutoffAt: job.cutoff_at,
    generatedAt: new Date().toISOString(),
    tables: job.tables ?? [],
    parts: job.parts ?? [],
    files,
    missing,
    filesCapped: job.files_capped,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await storeObject(svc, exportObjectPath(job.farm_id, job.id, "manifest.json"), bytes, "application/json");
  const { error } = await svc.rpc("export_job_finish", { p_job: job.id, p_token: token, p_manifest_sha256: sha256Hex(bytes) });
  if (error) throw error;
}

export type StepOutcome = { status: ExportJob["status"] | "busy" | "needs-session"; job?: ExportJob };

/**
 * Moves one job on by one bounded step. `session` is the requester's own client when their page
 * drives it (the route has checked their role and the lifecycle); null for the worker, which
 * may then only copy files and finish, after asking the database whether the requester still may.
 */
export async function runExportStep(svc: SupabaseClient, session: SupabaseClient | null, jobId: string, budgetMs: number): Promise<StepOutcome> {
  const { data: token, error: claimError } = await svc.rpc("export_job_claim", { p_job: jobId, p_seconds: Math.ceil(budgetMs / 1000) + 60 });
  if (claimError) throw claimError;
  if (!token) return { status: "busy" };
  const lease = String(token);
  const deadline = Date.now() + budgetMs;
  try {
    let job = await readJob(svc, jobId);
    if (!session) {
      const { data: allowed, error } = await svc.rpc("export_job_allowed", { p_job: jobId });
      if (error) throw error;
      if (!allowed) {
        await saveJob(svc, jobId, lease, { status: "failed", last_error: "access ended" });
        return { status: "failed" };
      }
    }
    if (job.status === "records") {
      if (!session) return { status: "needs-session" };
      if (!job.inventory_done) {
        await takeInventory(session, svc, job, lease);
        job = await readJob(svc, jobId);
      }
      await recordsStep(session, svc, job, lease, deadline);
    } else if (job.status === "files") {
      await filesStep(svc, session ? sessionReader(session) : serviceReader(svc), job, lease, deadline);
    } else if (job.status === "finishing") {
      await finishJob(svc, job, lease);
    }
    job = await readJob(svc, jobId);
    return { status: job.status, job };
  } catch (failure) {
    captureError(failure, { where: "export:step", extra: { job: jobId } });
    const message = failure instanceof Error ? failure.message.slice(0, 300) : "failed";
    await svc.from("farm_export_jobs").update({ last_error: message, updated_at: new Date().toISOString() }).eq("id", jobId).eq("lease_token", lease);
    throw failure;
  } finally {
    await svc.rpc("export_job_release", { p_job: jobId, p_token: lease });
  }
}

/** The nightly (or minute) worker: files and finishing for jobs nobody is watching. */
export async function runExportWorker(svc: SupabaseClient, budgetMs: number): Promise<string> {
  const until = Date.now() + budgetMs;
  const { data, error } = await svc
    .from("farm_export_jobs")
    .select("id")
    .in("status", ["files", "finishing"])
    .order("updated_at", { ascending: true })
    .limit(10);
  if (error) throw error;
  let moved = 0;
  let failed = 0;
  for (const row of (data ?? []) as { id: string }[]) {
    const left = until - Date.now();
    if (left < 5_000) break;
    try {
      const outcome = await runExportStep(svc, null, row.id, Math.min(left, 60_000));
      if (outcome.status !== "busy") moved += 1;
    } catch {
      failed += 1;
    }
  }
  return failed > 0 ? `error: ${failed} export step(s) failed (${moved} moved on)` : `ok (${moved} moved on)`;
}

/** Bounded cleanup: archives past their keeping time, failed ones, and objects whose job is gone. */
export async function cleanExportArchives(svc: SupabaseClient): Promise<string> {
  const { data, error } = await svc.rpc("export_jobs_to_clean", { p_limit: 20 });
  if (error) throw error;
  let archives = 0;
  let stuck = 0;
  for (const job of (data ?? []) as { id: string; farm_id: string; parts: number }[]) {
    const names = [...Array.from({ length: job.parts }, (_, i) => partName(i + 1)), "manifest.json"];
    const { error: removeError } = await svc.storage.from(EXPORT_BUCKET).remove(names.map((n) => exportObjectPath(job.farm_id, job.id, n)));
    if (removeError) {
      stuck += 1;
      continue;
    }
    const { error: markError } = await svc.rpc("export_job_mark_removed", { p_job: job.id });
    if (markError) throw markError;
    archives += 1;
  }
  const { data: orphans, error: orphanError } = await svc.rpc("export_orphan_objects", { p_limit: 200 });
  if (orphanError) throw orphanError;
  const paths = ((orphans ?? []) as { name: string }[]).map((o) => o.name);
  let swept = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error: sweepError } = await svc.storage.from(EXPORT_BUCKET).remove(batch);
    if (sweepError) stuck += batch.length;
    else swept += batch.length;
  }
  return stuck > 0
    ? `error: ${stuck} export archive(s) could not be removed; tried again tomorrow (${archives} removed, ${swept} orphans)`
    : `ok (${archives} archives removed, ${swept} orphans)`;
}
