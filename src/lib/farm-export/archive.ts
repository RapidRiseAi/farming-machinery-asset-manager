import { createHash } from "node:crypto";

import { exportArchivePath } from "@/lib/farm-export-policy";
import { zipStream } from "@/lib/zip";

/**
 * The complete export's archive (20261120110000): parts, names, checksums and the manifest.
 * Pure, so it is tested without storage or a database.
 *
 * == Parts ======================================================================================
 * A large business is delivered as numbered ZIP parts of about PART_TARGET_BYTES each, plus a
 * manifest, rather than one file: no single request has to build or carry the whole export, and
 * each part stays under the storage service's default per-object upload limit (Supabase,
 * "Storage file limits": 50 MB on the Free plan unless the project sets another limit; a file
 * larger than a part is stored alone in its own part). Photos and PDFs are already compressed,
 * so entries are stored as they are.
 *
 * == Names ======================================================================================
 * Nothing from a storage key or a table name reaches an archive path unchecked: files go through
 * `exportArchivePath` (hashed, portable, never `..` or an absolute path, chat and command audio
 * refused), records are `records/<table>.<chunk>.ndjson` for a plain table name.
 */

/** About 40 MB a part: under a 50 MB per-object upload limit with room for the ZIP headers. */
export const PART_TARGET_BYTES = 40_000_000;
/** How long a finished archive is kept for download, at most (and never past the reading window). */
export const ARCHIVE_KEEP_DAYS = 7;
/** A download link's life. A new one is made on every press while the archive is kept. */
export const LINK_SECONDS = 600;
/** Attempts at one file before it is reported missing rather than retried again. */
export const FILE_ATTEMPTS = 3;
/** Files listed for one export; beyond it the manifest says the export is capped. */
export const MAX_FILES = 200_000;
/** Exports a business may start in one South African day (each one copies every file). */
export const EXPORTS_PER_DAY = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The storage bucket of export archives: private, service role only, outside the storage pool. */
export const EXPORT_BUCKET = "farm-exports";

/** `exports/<farm>/<job>/<name>`: not under the business's own folder, so never counted in its pool. */
export function exportObjectPath(farmId: string, jobId: string, name: string): string {
  if (!UUID.test(farmId) || !UUID.test(jobId) || !/^(part-\d{4}\.zip|manifest\.json)$/.test(name)) {
    throw new Error("export: bad object path");
  }
  return `exports/${farmId}/${jobId}/${name}`;
}

export function partName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error("export: bad part number");
  return `part-${String(n).padStart(4, "0")}.zip`;
}

export function recordsEntryName(table: string, chunk: number): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table) || !Number.isInteger(chunk) || chunk < 1) throw new Error("export: bad table");
  return `records/${table}.${chunk}.ndjson`;
}

export function fileEntryName(bucket: string, path: string, farmId: string): string {
  return `files/${exportArchivePath(bucket, path, farmId)}`;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Why a file could not be copied, in the manifest's words. */
export function missingReason(error: { message?: string; status?: number; statusCode?: string | number } | null | undefined): "not_found" | "refused" | "error" {
  const status = Number(error?.status ?? error?.statusCode ?? NaN);
  const text = (error?.message ?? "").toLowerCase();
  if (status === 404 || /not.?found|does not exist/.test(text)) return "not_found";
  if (status === 401 || status === 403 || /not allowed|unauthori[sz]ed|forbidden|denied/.test(text)) return "refused";
  return "error";
}

/** The last moment a finished archive is kept: seven days, never past the owner's last reading day. */
export function archiveExpiresAt(readyAt: Date, retrievalEndsOn: string | null): Date {
  const week = new Date(readyAt.getTime() + ARCHIVE_KEEP_DAYS * 86_400_000);
  if (!retrievalEndsOn || !/^\d{4}-\d{2}-\d{2}$/.test(retrievalEndsOn)) return week;
  // The end of that day in South Africa (UTC+2, no daylight saving).
  const end = new Date(`${retrievalEndsOn}T22:00:00.000Z`);
  return end < week ? end : week;
}

/** One ZIP part in memory: the files of one step, never more than about a part's worth. */
export async function zipPart(entries: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  async function* each() {
    for (const e of entries) yield e;
  }
  const reader = zipStream(each()).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type TableMeta = { name: string; rows: number; status: "ok" | "unavailable" | "capped"; cutoff: "created_at" | "none" };
export type PartMeta = { n: number; name: string; bytes: number; sha256: string; entries: number; kind: "records" | "files" };
export type FileEntry = { archive_path: string; bucket: string; size: number; sha256: string; part: number };
export type MissingEntry = { bucket: string; name: string; reason: string };

export type ManifestInput = {
  jobId: string;
  farmId: string;
  requestedBy: string;
  role: string;
  cutoffAt: string;
  generatedAt: string;
  tables: TableMeta[];
  parts: PartMeta[];
  files: FileEntry[];
  missing: MissingEntry[];
  filesCapped: boolean;
};

/**
 * What the export holds and what it does not, said without revealing what was left out: a
 * restricted record is counted in no table, a missing file is named by its bucket and a hash of
 * its key, never by its contents.
 */
export function buildManifest(input: ManifestInput) {
  const unavailable = input.tables.filter((t) => t.status === "unavailable").map((t) => t.name);
  const capped = input.tables.filter((t) => t.status === "capped").map((t) => t.name);
  return {
    format: "fleetwise-complete-export/1",
    job_id: input.jobId,
    farm_id: input.farmId,
    requested_by: input.requestedBy,
    requester_role: input.role,
    cutoff_at: input.cutoffAt,
    generated_at: input.generatedAt,
    scope: [
      "Records and files of this one business that the person who asked may read, by the same rules as the app.",
      "Records are as they stood when each table was read; rows created after cutoff_at are left out where the table records when a row was created (tables[].cutoff).",
      "Files are those stored when the export started; a file removed since then is listed under missing.",
    ],
    omitted: [
      "Staff chat conversations and their attachments: private to their members, never part of a business export.",
      "Temporary spoken-command audio, sign-in data, payment card details and system ledgers.",
      ...(unavailable.length ? [`Tables this person may not read: ${unavailable.join(", ")}.`] : []),
      ...(capped.length ? [`Tables cut at the row limit: ${capped.join(", ")}.`] : []),
      ...(input.filesCapped ? [`Only the first ${MAX_FILES} files are listed; ask Rapid Rise for the rest.`] : []),
    ],
    counts: {
      tables: input.tables.length,
      rows: input.tables.reduce((n, t) => n + t.rows, 0),
      files: input.files.length,
      file_bytes: input.files.reduce((n, f) => n + f.size, 0),
      missing_files: input.missing.length,
      parts: input.parts.length,
    },
    tables: input.tables,
    parts: input.parts,
    files: input.files,
    missing: input.missing.map((m) => ({ bucket: m.bucket, key_sha256: sha256Hex(`${m.bucket}\0${m.name}`), reason: m.reason })),
  };
}
