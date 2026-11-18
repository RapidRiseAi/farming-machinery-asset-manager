import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exportArchivePath } from "./farm-export-policy";

/** The caller supplies their authenticated client, never a service client. Any missing
 * or refused object fails this legacy ZIP, rather than presenting a partial copy as whole. */
export async function* readExportFiles(
  session: SupabaseClient,
  files: readonly { bucket_id: string; name: string }[],
  farmId: string,
) {
  for (const file of files) {
    const name = exportArchivePath(file.bucket_id, file.name, farmId);
    const { data: blob, error } = await session.storage.from(file.bucket_id).download(file.name);
    if (error || !blob) throw new Error("export: file unavailable");
    yield { name, bytes: new Uint8Array(await blob.arrayBuffer()) };
  }
}
