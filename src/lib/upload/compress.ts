/**
 * One photo reducer for every upload (decision 13, BRIEF section 10): ordinary photos are
 * made smaller where important detail stays readable, the person can keep the original,
 * PDFs and recordings are never touched, and no second copy is stored.
 *
 * The numbers (limits.ts, docs/LIMITS.md "Photo reduction"): the long edge goes down to
 * 2560 pixels, never up, and JPEG quality is 0.85. A serial plate filling a tenth of a
 * phone photo's width is then about 256 pixels wide, so its characters stay twenty-odd
 * pixels tall; the old 1600-pixel, 0.7-quality reduction left them at about twelve, where
 * stamped digits and hairline cracks blur. A 12 MP phone photo comes out around 0.6 to
 * 1.2 MB instead of 3 to 6 MB.
 *
 * The original is used, unchanged, when the person asks for it, when the browser cannot
 * decode the file (HEIC on most browsers), when encoding fails, or when the reduced file
 * would not be smaller. EXIF orientation is applied while decoding (the stored pixels are
 * upright), so the reduced copy needs no orientation tag.
 */

import { PHOTO_JPEG_QUALITY, PHOTO_LONG_EDGE } from "@/lib/limits";

export type Decoded = { width: number; height: number; close(): void };

export type PhotoCodec = {
  decode(file: Blob): Promise<Decoded>;
  encode(image: Decoded, width: number, height: number, quality: number): Promise<Blob | null>;
};

export type PreparedFile = {
  file: Blob;
  mime: string;
  /** True when the stored file is the reduced copy (shown to the person). */
  reduced: boolean;
  /** Why the original was kept, when it was. */
  kept?: "asked" | "not_a_photo" | "cannot_decode" | "encode_failed" | "not_smaller";
  original: { width: number | null; height: number | null; bytes: number };
  stored: { width: number | null; height: number | null; bytes: number };
};

/** The size a photo is reduced to: the long edge at most `longEdge`, never enlarged. */
export function reducedSize(width: number, height: number, longEdge = PHOTO_LONG_EDGE): { width: number; height: number } {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const REDUCIBLE = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** The browser's own codec: createImageBitmap with EXIF orientation, a canvas, JPEG out. */
export const browserCodec: PhotoCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { width: bitmap.width, height: bitmap.height, close: () => bitmap.close(), bitmap } as Decoded & { bitmap: ImageBitmap };
  },
  async encode(image, width, height, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage((image as Decoded & { bitmap: ImageBitmap }).bitmap, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  },
};

export async function preparePhoto(file: Blob, keepOriginal: boolean, codec: PhotoCodec = browserCodec): Promise<PreparedFile> {
  const mime = (file.type || "").toLowerCase();
  const keep = (why: PreparedFile["kept"], width: number | null = null, height: number | null = null): PreparedFile => ({
    file, mime, reduced: false, kept: why,
    original: { width, height, bytes: file.size }, stored: { width, height, bytes: file.size },
  });
  if (!REDUCIBLE.has(mime)) return keep("not_a_photo");
  if (keepOriginal) return keep("asked");

  let image: Decoded;
  try {
    image = await codec.decode(file);
  } catch {
    return keep("cannot_decode");
  }
  try {
    const target = reducedSize(image.width, image.height);
    let blob: Blob | null = null;
    try {
      blob = await codec.encode(image, target.width, target.height, PHOTO_JPEG_QUALITY);
    } catch {
      blob = null;
    }
    if (!blob || blob.size === 0) return keep("encode_failed", image.width, image.height);
    if (blob.size >= file.size) return keep("not_smaller", image.width, image.height);
    return {
      file: blob, mime: "image/jpeg", reduced: true,
      original: { width: image.width, height: image.height, bytes: file.size },
      stored: { width: target.width, height: target.height, bytes: blob.size },
    };
  } finally {
    image.close();
  }
}
