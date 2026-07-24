// Client-only image helpers shared by the machine-photo uploaders (detail gallery +
// add-vehicle form). Downscale + JPEG re-encode keeps uploads ~200–400 KB on a
// mid-range Android (Scope §7). No server imports — safe in client components.

/** Downscale + re-encode an image File to a JPEG Blob (~200–400 KB). */
export async function compressImage(file: File, maxDim = 1600, quality = 0.7): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Compression failed"))),
      "image/jpeg",
      quality,
    ),
  );
}

/** Read a Blob as a base64 `data:` URL (used to ferry a compressed photo through a
 *  server-action form field before the machine — and its storage path — exists). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(blob);
  });
}
