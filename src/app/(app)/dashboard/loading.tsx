import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Route-level loading UI for the dashboard (React Suspense fallback). */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-24 rounded-lg" />
      </div>

      <Card>
        <Skeleton className="mb-3 h-5 w-32" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg bg-sand-50 py-3">
              <Skeleton className="mx-auto h-8 w-10" />
              <Skeleton className="mx-auto mt-2 h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-8 w-32" />
          </Card>
        ))}
      </div>

      <Card>
        <Skeleton className="mb-3 h-5 w-28" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="flex-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1.5 h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
