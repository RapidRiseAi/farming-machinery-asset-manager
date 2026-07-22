import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function JobCardsLoading() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-9 w-48 rounded-lg" />
      </div>
      <Card><Skeleton className="h-10 w-full" /></Card>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <div className="flex items-start justify-between">
              <div className="flex-1"><Skeleton className="h-4 w-40" /><Skeleton className="mt-1.5 h-3 w-28" /></div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
