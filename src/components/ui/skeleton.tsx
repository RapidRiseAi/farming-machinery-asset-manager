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
