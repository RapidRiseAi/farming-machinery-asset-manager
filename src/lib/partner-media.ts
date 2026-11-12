import { createServiceClient } from "@/lib/supabase/service";
import { captureError } from "@/lib/observability";
import { soft } from "@/lib/supabase/must";
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
