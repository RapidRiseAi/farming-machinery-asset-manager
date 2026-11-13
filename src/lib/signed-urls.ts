import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Signed URLs for many objects in one bucket, in ONE request, keyed by path.
 *
 * Pages that showed photos signed them one at a time, a round trip per photo. Storage's
 * batch call answers for every path at once and reports a missing object inline, on its
 * own row, instead of failing the whole call, so one file deleted behind our back still
 * leaves every other photo showing.
 *
 * `error` is the first problem met: the whole call failing, or else the first object that
 * would not sign. Each caller reports it the way it reported a failed single sign before
 * (`soft`, a client report, or not at all); this module reports nothing itself, because it
 * is used from the browser as well as the server.
 */
export type SignedUrls = { urls: Map<string, string>; error: { message?: string; code?: string } | null };

export async function signedUrlsByPath(
  client: Pick<SupabaseClient, "storage">,
  bucket: string,
  paths: readonly (string | null | undefined)[],
  expiresIn: number,
): Promise<SignedUrls> {
  const wanted = [...new Set(paths.filter((p): p is string => !!p))];
  const urls = new Map<string, string>();
  if (wanted.length === 0) return { urls, error: null };

  const { data, error } = await client.storage.from(bucket).createSignedUrls(wanted, expiresIn);
  if (error) return { urls, error };

  let first: SignedUrls["error"] = null;
  for (const row of data ?? []) {
    if (row.path && row.signedUrl && !row.error) urls.set(row.path, row.signedUrl);
    else first ??= { message: row.error ?? "not signed" };
  }
  // A path the answer left out entirely is as missing as one it refused.
  if (!first && urls.size < wanted.length) first = { message: "not signed" };
  return { urls, error: first };
}
