import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-header";

/** The shape of the list as it lands: header, search, then compact machine cards. */
export default function MachinesLoading() {
  return (
    <PageContainer size="wide">
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-56 max-w-full" />
      </div>
      <Skeleton className="h-12 w-full rounded-lg" />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="p-3">
            <div className="flex items-start gap-3">
              <Skeleton className="h-14 w-14 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-40 max-w-full" />
                <Skeleton className="mt-1.5 h-3 w-56 max-w-full" />
                <Skeleton className="mt-3 h-5 w-24 rounded-full" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </PageContainer>
  );
}
