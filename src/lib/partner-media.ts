import { createServiceClient } from "@/lib/supabase/service";
import { captureError } from "@/lib/observability";
import { soft } from "@/lib/supabase/must";

/**
 * Storage for partner branding and partner documents (F14, migration 0382).
 *
 * Two buckets, because the two things are scoped differently:
 *   `partner-branding`  `{workshop_id}/…`          the partner's logo
 *   `partner-docs`      `{farm_id}/{doc_id}/…`     uploaded quotes/invoices, payment proofs
 *
 * Reads are served as short-lived signed URLs generated server-side, exactly as the
 * machine-photo and checklist-photo flows do, no bucket is ever made public.
 */

const MAX_FILE = 8 * 1024 * 1024;
const SIGNED_TTL = 60 * 60;

/** A signed URL for a partner's logo, or null when they have not uploaded one. */
export async function signedBrandingUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const svc = createServiceClient();
  // A page without the logo is still honest; a logo on file that cannot be signed is
  // reported rather than passed off as "none uploaded".
  const data = soft(await svc.storage.from("partner-branding").createSignedUrl(path, SIGNED_TTL), "partner-media:branding-url");
  return data?.signedUrl ?? null;
}

/** The raw bytes of a partner's logo, for embedding in a PDF. Null if unavailable. */
export async function brandingLogoBytes(
  path: string | null,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!path) return null;
  const svc = createServiceClient();
  const { data, error } = await svc.storage.from("partner-branding").download(path);
  // The PDF still goes out without its logo, but we hear that it did.
  if (error) captureError(error, { where: "partner-media:logo-bytes" });
  if (error || !data) return null;
  const bytes = new Uint8Array(await data.arrayBuffer());
  // pdf-lib embeds PNG and JPEG only; anything else (SVG, WebP) is skipped rather than
  // crashing the document a partner is trying to send.
  const contentType = data.type || "";
  if (!/png|jpe?g/i.test(contentType)) return null;
  return { bytes, contentType };
}

/** A signed URL for a document file or payment proof stored in `partner-docs`. */
export async function signedDocUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const svc = createServiceClient();
  // Reported, so a file on record that cannot be opened is heard about; the page itself
  // (totals, payments, decisions) still stands without the link.
  const data = soft(await svc.storage.from("partner-docs").createSignedUrl(path, SIGNED_TTL), "partner-media:doc-url");
  return data?.signedUrl ?? null;
}

/**
 * Store a partner document file (the PDF they produced in their own system) or a proof
 * of payment. Runs as the service role from a trusted server route, writing under
 * `{farm_id}/{document_id}/…` so the farm-scoped storage RLS (0382) governs reads.
 * Returns the object key, or null when there was no usable file.
 */
export async function uploadPartnerDocFile(
  svc: ReturnType<typeof createServiceClient>,
  file: File | null,
  farmId: string,
  documentId: string,
  label: "document" | "proof",
): Promise<string | null> {
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE) return null;

  const ext = file.type.includes("pdf") ? "pdf" : file.type.startsWith("image/") ? "jpg" : "bin";
  const path = `${farmId}/${documentId}/${label}-${crypto.randomUUID()}.${ext}`;
  const buf = new Uint8Array(await file.arrayBuffer());
  const up = await svc.storage.from("partner-docs").upload(path, buf, {
    contentType: file.type || "application/octet-stream",
  });
  // A failed upload is not "no usable file": the caller still gets null, and we hear of it.
  if (up.error) {
    captureError(up.error, { where: "partner-media:upload" });
    return null;
  }

  const { error: attachmentError } = await svc.from("attachments").insert({
    farm_id: farmId,
    parent_type: "partner_document",
    parent_id: documentId,
    kind: label === "proof" ? "photo" : "invoice",
    storage_path: path,
    created_by: null,
  });
  if (attachmentError) {
    captureError(attachmentError, { where: "partner-media:upload-attachment" });
    // Best effort: an orphaned file is harmless, but worth knowing about.
    const { error: removeError } = await svc.storage.from("partner-docs").remove([path]);
    if (removeError) captureError(removeError, { where: "partner-media:upload-cleanup" });
    return null;
  }
  return path;
}
