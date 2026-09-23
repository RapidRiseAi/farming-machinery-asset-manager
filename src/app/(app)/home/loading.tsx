import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function HomeLoading() {
  return <PageSkeleton shape="board" rows={4} />;
}
