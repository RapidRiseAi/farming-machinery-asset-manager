import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The supplier's own tax invoice, attached to an expense (G6, bucket from migration 0430).
 *
 * `partner-receipts` and its policies were created with the expenses table; the column
 * `partner_expenses.receipt_path` has been on the row since then. Only the way to put a
 * file there was missing, which meant the one document SARS actually asks a vendor to
 * hold could not be held.
 *
 * Everything here goes through the CALLER'S RLS client rather than the service role. That
 * is a deliberate difference from `partner-media.ts`: the 0430 policies already scope this
 * bucket to `app.user_workshop_id()` by the first path segment, so RLS is both necessary
 * and sufficient, and routing around it with a service key would replace a database-
 * enforced rule with an application-enforced one. It also means this works anywhere the
 * app can sign in, with no extra secret.
 *
 * Path is `{workshop_id}/{expense_id}/{filename}` — the first segment is what the policy
 * reads, so a partner cannot write into another partner's folder even by crafting the rest.
 */

const MAX_FILE = 8 * 1024 * 1024;
const SIGNED_TTL = 60 * 60;

/** What a supplier hands over: a phone photo, a scan, or a PDF off their system. */
const ALLOWED = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;

export type ReceiptUpload = { path: string } | { error: "too_big" | "wrong_type" | "no_file" | "failed" };

/** Store a receipt and return its object path. Never throws — the caller shows the reason. */
export async function uploadReceipt(
  supabase: SupabaseClient,
  file: unknown,
  workshopId: string,
  expenseId: string,
): Promise<ReceiptUpload> {
  if (!(file instanceof File) || file.size === 0) return { error: "no_file" };
  if (file.size > MAX_FILE) return { error: "too_big" };
  if (!ALLOWED.test(file.type)) return { error: "wrong_type" };

  // Keep the extension (so the browser renders a PDF as a PDF) but not the supplier's
  // filename, which is arbitrary user input on a path.
  const ext = file.type === "application/pdf" ? "pdf" : (file.type.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
  const path = `${workshopId}/${expenseId}/receipt-${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from("partner-receipts")
    .upload(path, file, { contentType: file.type, upsert: true });

  return error ? { error: "failed" } : { path };
}

/** A short-lived signed URL for one receipt, or null if there is none. */
export async function signedReceiptUrl(
  supabase: SupabaseClient,
  path: string | null | undefined,
): Promise<string | null> {
  if (!path) return null;
  const { data } = await supabase.storage.from("partner-receipts").createSignedUrl(path, SIGNED_TTL);
  return data?.signedUrl ?? null;
}

/** Signed URLs for a page-worth of receipts, keyed by path. One round trip, not N. */
export async function signedReceiptUrls(
  supabase: SupabaseClient,
  paths: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(paths.filter((p): p is string => !!p))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;

  const { data } = await supabase.storage.from("partner-receipts").createSignedUrls(wanted, SIGNED_TTL);
  for (const row of data ?? []) {
    // createSignedUrls reports per-object failures inline rather than throwing, so a single
    // missing object (deleted behind our back) must not take the whole page down.
    if (row.path && row.signedUrl && !row.error) out.set(row.path, row.signedUrl);
  }
  return out;
}

/**
 * Whether this expense is claiming VAT it cannot yet support with a document.
 *
 * The founder's call was to WARN, never block: capture happens in a yard on a phone and
 * the paper arrives later, so refusing the save would just push the record back into a
 * shoebox. But an input-VAT claim with no tax invoice behind it is the thing an auditor
 * disallows, so it has to be visible — on the row, and totalled on the VAT return.
 */
export function claimNeedsProof(e: {
  vat_cents: number;
  vat_claimable: boolean;
  receipt_path: string | null;
}): boolean {
  return e.vat_claimable && e.vat_cents > 0 && !e.receipt_path;
}
