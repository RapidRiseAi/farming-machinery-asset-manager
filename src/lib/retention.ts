import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { removeFiles, type StoredFile } from "@/lib/farm-closure";
import { captureError } from "@/lib/observability";

/**
 * Scheduled deletion after the owner's reading window (20261120120000), the nightly part.
 *
 * Always: the schedule is brought up to date and a dry-run preview stored for each business
 * (`retention_schedule_run`); while deletion is switched off that is all, and nobody is told
 * anything. Deletion needs BOTH switches: the database setting the founder turns on with a typed
 * phrase (`retention_set_enabled`), and `RETENTION_DELETION=enabled` on the deployment. With both,
 * each due business goes through `retention_delete`, which checks everything again and runs the
 * owner's own permanent closure in one transaction; files and logins follow here and are finished
 * on later nights if anything is left (`farm_closures.pending_files` and `pending_logins`).
 *
 * Every closure is also written to the deletion ledger in Storage (bucket `deletion-ledger`), which
 * a database restore does not roll back: after a restore, docs/BACKUP.md's procedure closes again
 * any business the ledger says was closed.
 */

export const LEDGER_BUCKET = "deletion-ledger";

/** Both switches: the database's setting is checked inside the database. */
export function retentionDeletionArmed(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_DELETION === "enabled";
}

/** A closure, by ids and dates only (no names), where a database restore cannot undo it. */
export async function writeLedger(
  svc: SupabaseClient,
  entry: { closureId: string; farmId: string; reason: "owner" | "retention"; closedAt: string },
): Promise<boolean> {
  const body = JSON.stringify({ closure_id: entry.closureId, farm_id: entry.farmId, reason: entry.reason, closed_at: entry.closedAt });
  const { error } = await svc.storage
    .from(LEDGER_BUCKET)
    .upload(`closures/${entry.closureId}.json`, new TextEncoder().encode(body), { contentType: "application/json", upsert: true });
  if (error) captureError(error, { where: "retention:ledger" });
  return !error;
}

/** Remove logins that belong nowhere else; returns those still to remove. */
export async function removeLogins(svc: SupabaseClient, ids: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const id of ids) {
    const { error } = await svc.auth.admin.deleteUser(id);
    // Already gone counts as done.
    if (error && !/not found/i.test(error.message ?? "")) {
      captureError(error, { where: "retention:login" });
      left.push(id);
    }
  }
  return left;
}

type DeleteResult = { closure: string; logins: string[]; files: StoredFile[] };

/** The nightly step. Its result starts with "ok" unless something needs a person. */
export async function runRetention(svc: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<string> {
  const { data: run, error: runError } = await svc.rpc("retention_schedule_run");
  if (runError) throw runError;
  const summary = run as { scheduled: number; cancelled: number; warned: number; deletion_enabled: boolean };
  const head = `scheduled ${summary.scheduled}, cancelled ${summary.cancelled}, warned ${summary.warned}`;
  if (!summary.deletion_enabled || !retentionDeletionArmed(env)) return `ok (${head}; deletion off, dry run only)`;

  const { data: due, error: dueError } = await svc.rpc("retention_due", { p_limit: 5 });
  if (dueError) throw dueError;
  let deleted = 0;
  let failed = 0;
  for (const row of (due ?? []) as { farm_id: string }[]) {
    const { data, error } = await svc.rpc("retention_delete", { p_farm: row.farm_id });
    if (error) {
      failed += 1;
      captureError(error, { where: "retention:delete", extra: { farm: row.farm_id } });
      await svc.rpc("retention_mark_failed", { p_farm: row.farm_id, p_error: error.message ?? "failed" });
      continue;
    }
    const result = data as DeleteResult;
    deleted += 1;
    const filesLeft = await removeFiles(svc, result.files ?? []);
    const loginsLeft = await removeLogins(svc, result.logins ?? []);
    const { error: saveError } = await svc
      .from("farm_closures")
      .update({ pending_files: filesLeft, pending_logins: loginsLeft })
      .eq("id", result.closure);
    if (saveError) captureError(saveError, { where: "retention:pending" });
    await writeLedger(svc, { closureId: result.closure, farmId: row.farm_id, reason: "retention", closedAt: new Date().toISOString() });
  }
  return failed > 0
    ? `error: ${failed} deletion(s) failed and were recorded (${head}; ${deleted} deleted)`
    : `ok (${head}; ${deleted} deleted)`;
}

/** Logins a closure could not remove yet, tried again (bounded). */
export async function finishClosureLogins(svc: SupabaseClient): Promise<string> {
  const { data, error } = await svc.from("farm_closures").select("id, pending_logins").neq("pending_logins", "{}").limit(20);
  if (error) throw error;
  let removed = 0;
  let stuck = 0;
  for (const row of (data ?? []) as { id: string; pending_logins: string[] }[]) {
    const left = await removeLogins(svc, row.pending_logins);
    removed += row.pending_logins.length - left.length;
    stuck += left.length;
    const { error: saveError } = await svc.from("farm_closures").update({ pending_logins: left }).eq("id", row.id);
    if (saveError) throw saveError;
  }
  return stuck > 0 ? `error: ${stuck} login(s) of closed accounts could not be removed; tried again tomorrow (${removed} removed)` : `ok (${removed} removed)`;
}
