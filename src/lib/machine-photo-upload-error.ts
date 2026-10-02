// Client-safe. Turns whatever a machine-photo upload threw into an i18n key, so a
// farmer reads a sentence in their own language instead of a raw Supabase storage
// or RLS message in English. The raw error goes to the console for the developer.

/** Is this file one the photo pickers can read? Decided before any work is done. */
export function looksLikeImage(file: File): boolean {
  // Some Android galleries hand over an empty type; let those through and let the
  // decoder decide, rather than refusing a real photo.
  return file.type === "" || file.type.startsWith("image/");
}

/**
 * The i18n key for a failed photo upload.
 *
 * - offline: no signal, the commonest cause on a farm, and the one with a clear fix;
 * - not an image: the browser could not decode it (`createImageBitmap` throws a
 *   DOMException), or it was not an image to begin with;
 * - too large: the storage API refused the size (HTTP 413 or its message);
 * - anything else: the generic "Upload failed".
 */
export function photoUploadErrorKey(error: unknown, online: boolean): string {
  if (typeof console !== "undefined") console.warn("[machine-photo] upload failed", error);
  if (!online) return "machine.uploadOffline";
  if (typeof DOMException !== "undefined" && error instanceof DOMException) return "machine.uploadNotImage";
  const e = error as { statusCode?: string | number; status?: number; message?: string } | null;
  const status = Number(e?.statusCode ?? e?.status ?? 0);
  const message = String(e?.message ?? "").toLowerCase();
  if (status === 413 || message.includes("too large") || message.includes("maximum allowed size")) {
    return "machine.uploadTooLarge";
  }
  if (message.includes("failed to fetch") || message.includes("network")) return "machine.uploadOffline";
  return "machine.uploadFailed";
}
