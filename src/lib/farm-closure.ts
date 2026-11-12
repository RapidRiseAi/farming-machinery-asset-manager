import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { captureError } from "@/lib/observability";

/**
 * Permanent closure (20261107100000). The order is the founder's: the owner takes everything
 * with them, confirms from their email, and it is gone with no cooling-off. So every step
 * before the last is there to make sure this is the right person, on purpose.
 */

/** A closure is not a thing to confirm from a week-old email. */
export const CLOSURE_LINK_HOURS = 24;

/** How recent the export must be, so the file in hand is the file that matters. */
const EXPORT_FRESH_HOURS = 24;

export const CLOSURE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashClosureToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function newClosureToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashClosureToken(token) };
}

export function exportIsFresh(lastExportAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastExportAt) return false;
  const age = now.getTime() - new Date(lastExportAt).getTime();
  return age >= 0 && age <= EXPORT_FRESH_HOURS * 60 * 60 * 1000;
}

/** Typed by hand, so spacing and capitals are not what stops somebody. */
export function sameBusinessName(typed: string, name: string): boolean {
  const plain = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return plain(typed) !== "" && plain(typed) === plain(name);
}

export type StoredFile = { bucket: string; path: string };

/** Remove files, a bucket at a time. Returns what is still there, for the nightly job. */
export async function removeFiles(svc: SupabaseClient, files: StoredFile[]): Promise<StoredFile[]> {
  const left: StoredFile[] = [];
  const buckets = new Map<string, string[]>();
  for (const f of files) buckets.set(f.bucket, [...(buckets.get(f.bucket) ?? []), f.path]);
  for (const [bucket, paths] of buckets) {
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { error } = await svc.storage.from(bucket).remove(batch);
      if (error) {
        captureError(error, { where: "closure:remove-files" });
        left.push(...batch.map((path) => ({ bucket, path })));
      }
    }
  }
  return left;
}

/**
 * Finish what a closure could not. A step of the nightly job, whose result must start with
 * "ok" or the whole night is reported as failed (and the founder emailed): "0 removed" did
 * exactly that on 11 November. Files that still will not go are a real failure, and say so.
 */
export async function finishClosureFiles(svc: SupabaseClient): Promise<string> {
  const { data, error } = await svc
    .from("farm_closures")
    .select("id, pending_files")
    .neq("pending_files", "[]")
    .limit(20);
  if (error) throw error;
  let removed = 0;
  let stuck = 0;
  for (const row of (data ?? []) as { id: string; pending_files: StoredFile[] }[]) {
    const left = await removeFiles(svc, row.pending_files);
    removed += row.pending_files.length - left.length;
    stuck += left.length;
    const { error: saveError } = await svc.from("farm_closures").update({ pending_files: left }).eq("id", row.id);
    if (saveError) throw saveError;
  }
  return stuck > 0
    ? `error: ${stuck} file(s) of closed accounts could not be removed; tried again tomorrow (${removed} removed)`
    : `ok (${removed} removed)`;
}
