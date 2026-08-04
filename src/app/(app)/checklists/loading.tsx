import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function ChecklistsLoading() {
  return <PageSkeleton shape="list" rows={6} />;
}
