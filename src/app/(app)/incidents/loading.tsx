import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function IncidentsLoading() {
  return <PageSkeleton shape="list" rows={5} />;
}
