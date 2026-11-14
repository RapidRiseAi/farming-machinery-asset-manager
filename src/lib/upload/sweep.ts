import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { captureError } from "@/lib/observability";

/**
 * The nightly upload sweep (a step of /api/cron/nightly). The database marks intents whose
 * window lapsed as expired (their reservations stop counting at once) and names the objects
 * of expired and refused uploads; this removes them from Storage, bucket by bucket, and
 * tells the database which went, so each is removed once. A removal that fails stays named
 * and is tried again the next night. Returns the counts for the run's record.
 */
export async function sweepUploads(svc: SupabaseClient, limit = 500): Promise<string> {
  const { data, error } = await svc.rpc("cron_upload_expire_sweep", { p_limit: limit });
  if (error) throw new Error(`upload sweep: ${error.code ?? "no code"}`);
  const answer = (data ?? {}) as { expired?: number; objects?: Array<{ id: string; bucket: string; path: string }> };
  const byBucket = new Map<string, Array<{ id: string; path: string }>>();
  for (const object of answer.objects ?? []) {
    byBucket.set(object.bucket, [...(byBucket.get(object.bucket) ?? []), { id: object.id, path: object.path }]);
  }
  const removed: string[] = [];
  let failed = 0;
  for (const [bucket, objects] of byBucket) {
    const { error: removeError } = await svc.storage.from(bucket).remove(objects.map((o) => o.path));
    if (removeError) {
      failed += objects.length;
      captureError(removeError, { where: "cron:upload_sweep:remove", extra: { bucket } });
      continue;
    }
    // Storage answers a removal of an object that is not there (never uploaded) without an
    // error, so every named object is now gone either way.
    removed.push(...objects.map((o) => o.id));
  }
  if (removed.length) {
    const { error: markError } = await svc.rpc("cron_upload_mark_removed", { p_ids: removed });
    if (markError) throw new Error(`upload sweep mark: ${markError.code ?? "no code"}`);
  }
  if (failed) throw new Error(`upload sweep: ${failed} object(s) could not be removed, ${removed.length} removed`);
  return `ok (expired ${answer.expired ?? 0}, removed ${removed.length})`;
}
