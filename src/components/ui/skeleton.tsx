import { cn } from "./cn";

export type SkeletonProps = {
  className?: string;
};

/** A pulsing placeholder block. Size it with `className` (h-*, w-*, rounded-*). */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-sand-200/70", className)}
      aria-hidden
    />
  );
}

/** A few lines of skeleton text. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
