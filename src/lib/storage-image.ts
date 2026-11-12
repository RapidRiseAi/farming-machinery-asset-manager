

export type ImageSize = "thumb" | "card" | "detail" | "full";

/**
 * Intrinsic dimensions to put on the `<img>`.
 *
 * These are NOT a display size, CSS still decides that. They exist so the
 * browser can reserve the right box before the bytes arrive. Without them every
 * photo in a list shifts the layout as it lands (Cumulative Layout Shift), which
 * is exactly what the machines list was doing on every load.
 *
 * A 4:3 box is used because that is what a phone camera produces and what
 * `compressImage` preserves; `object-cover` absorbs anything that isn't.
 */
export const INTRINSIC: Record<ImageSize, { width: number; height: number }> = {
  thumb: { width: 128, height: 96 },
  card: { width: 320, height: 240 },
  detail: { width: 768, height: 576 },
  full: { width: 1600, height: 1200 },
};
