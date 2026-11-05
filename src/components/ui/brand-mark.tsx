import Image from "next/image";
import { cn } from "./cn";

/**
 * The FleetWise mark: the founder's logo, a green F and a gold W on black.
 *
 * It is the official PNG (public/brand/fleetwise-logo.png, the same file the website
 * uses), never traced or recoloured, as the brand guide asks (fleetwise-website
 * docs/brand/BRAND.md). `fleetwise-mark.png` is that file cropped to the mark with a
 * little of its own black around it, 243 x 160; the app icons are drawn from it the same
 * way. It used to be a tractor icon on a green tile, which was nobody's logo.
 *
 * Decorative: whatever carries it (the home link, the wordmark beside it) has the name.
 * `unoptimized`, because it is a 12 KB static file the optimiser would only re-encode.
 */
export function BrandMark({
  className,
  priority = false,
  size = "md",
}: {
  className?: string;
  priority?: boolean;
  /** `md` beside a wordmark (36px tall), `lg` as the subject of a panel (80px). */
  size?: "md" | "lg";
}) {
  return (
    <Image
      src="/brand/fleetwise-mark.png"
      width={243}
      height={160}
      alt=""
      aria-hidden
      unoptimized
      priority={priority}
      // One alignment per size: in a flex column the mark would otherwise stretch to the
      // full width, flattened (the sign-in panel, found in a screenshot).
      className={cn("w-auto shrink-0", size === "lg" ? "h-20 self-start" : "h-9 self-center rounded-md", className)}
    />
  );
}

/**
 * The name beside the mark, as the website writes it: "Fleet" in the surrounding ink and
 * "Wise" in the brand colour that reads on that ground (green on a light page, gold on the
 * green sidebar). A white-labelled name (NEXT_PUBLIC_APP_NAME) is shown whole.
 */
export function Wordmark({
  name,
  tone = "page",
  className,
}: {
  name: string;
  tone?: "page" | "nav";
  className?: string;
}) {
  const split = name === "FleetWise";
  return (
    <span className={cn("text-lg font-bold tracking-tight", tone === "nav" ? "text-nav-ink" : "text-ink", className)}>
      {split ? (
        <>
          Fleet<span className={tone === "nav" ? "text-nav-accent" : "text-brand-ink"}>Wise</span>
        </>
      ) : (
        name
      )}
    </span>
  );
}
