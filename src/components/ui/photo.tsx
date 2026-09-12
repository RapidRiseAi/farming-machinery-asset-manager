import type { ReactNode } from "react";
import { cn } from "./cn";
import { INTRINSIC, type ImageSize } from "@/lib/storage-image";

/**
 * A photo from Storage, or a placeholder when there isn't one.
 *
 * Every image in this product was previously a bare `<img src>` — 13 of them,
 * none with `width`/`height`, none with `loading`, none with `decoding`. So the
 * machines list fetched every machine's photo at once and shifted the layout as
 * each one landed.
 *
 * This component makes the correct version the easy version:
 *
 *   • intrinsic `width`/`height` reserve the box → no layout shift
 *   • `loading="lazy"` → only what's on screen is fetched (opt out with
 *     `priority` for an above-the-fold hero, where lazy would delay the LCP)
 *   • `decoding="async"` → decoding never blocks the main thread
 *   • a real placeholder, so "no photo yet" looks deliberate rather than broken
 *
 * `next/image` is deliberately not used: these are signed URLs with a one-hour
 * expiry, so the optimiser would key its cache on a URL that changes hourly and
 * re-fetch every time — all of the cost, none of the benefit.
 */
export type PhotoProps = {
  /** Signed URL, or null/undefined when the record has no photo. */
  src?: string | null;
  /**
   * Describe the photo for someone who can't see it. Pass "" ONLY when the
   * photo is decorative and the machine is already named in adjacent text —
   * an empty alt is correct there, a missing one never is.
   */
  alt: string;
  /** Which rendered size this is. Drives the reserved box. */
  size?: ImageSize;
  /** Shown when there is no photo. Defaults to a neutral panel. */
  placeholder?: ReactNode;
  /** Above the fold? Loads eagerly and decodes first. Use sparingly. */
  priority?: boolean;
  /** Classes for the wrapper (set the display size and radius here). */
  className?: string;
  /** Classes for the <img> itself. */
  imgClassName?: string;
};

export function Photo({
  src,
  alt,
  size = "card",
  placeholder,
  priority = false,
  className,
  imgClassName,
}: PhotoProps) {
  const box = INTRINSIC[size];
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-surface-sunken",
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed URLs expire hourly; see the note above.
        <img
          src={src}
          alt={alt}
          width={box.width}
          height={box.height}
          loading={priority ? "eager" : "lazy"}
          decoding={priority ? "sync" : "async"}
          fetchPriority={priority ? "high" : "auto"}
          className={cn("h-full w-full object-cover", imgClassName)}
        />
      ) : (
        <span
          aria-hidden
          className="flex h-full w-full items-center justify-center text-ink-subtle"
        >
          {placeholder}
        </span>
      )}
    </div>
  );
}
