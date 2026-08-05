import { Card } from "./card";
import { Skeleton } from "./skeleton";

export type SkeletonShape = "list" | "detail" | "form" | "board" | "table";

/**
 * The placeholder a route shows while its data is still being fetched.
 *
 * Every page in this app is dynamic — it authenticates, resolves the current farm and
 * queries under RLS before it can render anything — so without a `loading.tsx` the
 * previous screen simply sits there after a tap, looking like the app has hung. These
 * shapes are deliberately coarse: they hold the layout so it does not jump when the
 * real content lands, without pretending to know what is in it.
 */
export function PageSkeleton({
  shape = "list",
  rows = 6,
}: {
  shape?: SkeletonShape;
  rows?: number;
}) {
  return (
    // `aria-busy` on the region, and a live-region label, so the wait is announced once
    // rather than being silence for anyone not watching the pixels.
    <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-52" />
          <Skeleton className="h-3.5 w-72" />
        </div>
        <Skeleton className="h-12 w-36 rounded-lg" />
      </div>

      {shape === "board" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-7 w-16" />
              </Card>
            ))}
          </div>
          <Card>
            <Skeleton className="h-4 w-40" />
            <div className="mt-3 flex flex-col gap-2.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="mt-1.5 h-3 w-3/5" />
                  </div>
                  <Skeleton className="h-9 w-24 rounded-lg" />
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {shape === "list" ? (
        <>
          <div className="flex gap-2 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-24 shrink-0 rounded-full" />
            ))}
          </div>
          <div className="flex flex-col gap-2.5">
            {Array.from({ length: rows }).map((_, i) => (
              <Card key={i}>
                <div className="flex items-start gap-3">
                  <Skeleton className="h-16 w-16 shrink-0 rounded-lg" />
                  <div className="flex-1">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="mt-1.5 h-3 w-3/4" />
                    <Skeleton className="mt-2.5 h-5 w-24 rounded-full" />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}

      {shape === "table" ? (
        <Card>
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-9 w-full" />
            {Array.from({ length: rows }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        </Card>
      ) : null}

      {shape === "detail" ? (
        <>
          <Card>
            <div className="flex flex-wrap items-start gap-4">
              <Skeleton className="h-28 w-28 rounded-xl" />
              <div className="flex-1">
                <Skeleton className="h-6 w-56" />
                <Skeleton className="mt-2 h-3.5 w-72" />
                <div className="mt-3 flex gap-2">
                  <Skeleton className="h-6 w-24 rounded-full" />
                  <Skeleton className="h-6 w-28 rounded-full" />
                </div>
              </div>
            </div>
          </Card>
          <div className="flex gap-2 overflow-hidden border-b border-sand-200 pb-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-24 shrink-0" />
            ))}
          </div>
          <Card>
            <Skeleton className="h-4 w-44" />
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i}>
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="mt-1.5 h-4 w-36" />
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      {shape === "form" ? (
        <Card>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="mt-1.5 h-12 w-full rounded-lg" />
              </div>
            ))}
          </div>
          <Skeleton className="mt-4 h-12 w-40 rounded-lg" />
        </Card>
      ) : null}
    </div>
  );
}
