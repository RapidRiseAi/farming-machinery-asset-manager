import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function CalendarLoading() {
  return <PageSkeleton shape="list" rows={6} />;
}
