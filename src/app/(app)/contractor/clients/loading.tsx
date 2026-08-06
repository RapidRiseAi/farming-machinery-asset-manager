import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function ClientsLoading() {
  return <PageSkeleton shape="list" rows={6} />;
}
