/**
 * Sized images out of Supabase Storage.
 *
 * The problem this exists to solve: `compressImage()` stores a machine photo at
 * 1600px / q0.7 — right for a full-screen look at a machine — and the machines
 * list then renders that same asset into a 132px thumbnail. A 15-machine fleet
 * was several megabytes to paint one list, on the mid-range Android over rural
 * data that Scope §7 names as the target device.
 *
 * Supabase Storage can resize on the render endpoint, so the fix is to ask for
 * the size actually being displayed rather than to store a second copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — image transformation is a PAID Supabase feature. If the project's
 * plan does not include it, the render endpoint rejects the request and the
 * image fails to load, which is worse than a large image. So it is OFF unless
 * `NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORM=1` is set.
 *
 * With it off you still get the lazy loading, the explicit dimensions and the
 * async decode from `<Photo>` — which is most of the perceived-speed win and
 * carries no dependency at all. Turn it on once the plan is confirmed; the
 * call sites do not change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Whether this deployment may ask Storage to resize. See the note above. */
export const IMAGE_TRANSFORM_ENABLED =
  process.env.NEXT_PUBLIC_SUPABASE_IMAGE_TRANSFORM === "1";

export type ImageSize = "thumb" | "card" | "detail" | "full";

/**
 * The rendered widths this app actually uses, at 2× for high-DPI phones.
 * `full` means "don't resize" — the lightbox and the print sheet want the
 * original.
 */
export const IMAGE_WIDTH: Record<ImageSize, number | null> = {
  thumb: 128, // desktop table thumbnail (64px CSS)
  card: 320, // mobile machine card (132–160px CSS)
  detail: 768, // machine detail header
  full: null,
};

export type TransformOpts = { width: number; quality?: number };

/**
 * The options object to hand `createSignedUrl`.
 * Returns `undefined` when transformation is disabled, so the call site reads
 * the same either way:
 *
 *   createSignedUrl(path, 3600, signedUrlOpts("detail"))
 *
 * ── Only works on the SINGLE-object call ─────────────────────────────────────
 * `createSignedUrls` (plural, used where a list signs many photos at once) takes
 * no `transform`, and the parameters cannot be appended to the returned URL
 * afterwards because the signature covers the transformation. Signing a list's
 * photos one at a time purely to resize them would trade N round trips for the
 * bytes, which is the wrong way round on a list.
 *
 * Lists therefore rely on `<Photo>` alone — intrinsic dimensions and lazy
 * loading, which need no server support and are most of the win.
 */
export function signedUrlOpts(size: ImageSize) {
  const width = IMAGE_WIDTH[size];
  if (!IMAGE_TRANSFORM_ENABLED || width === null) return undefined;
  return { transform: { width, resize: "contain" as const, quality: 62 } };
}

/**
 * Intrinsic dimensions to put on the `<img>`.
 *
 * These are NOT a display size — CSS still decides that. They exist so the
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
