import { PageSkeleton } from "@/components/ui/page-skeleton";

/**
 * `/billing` authenticates, resolves the current farm and then runs nine RLS-scoped
 * queries before it can render a single figure. Without this the previous screen simply
 * sits there after the tap, which on a money page reads as "it did not work".
 *
 * `detail` rather than `list`: the real screen is a stack of cards, not a row of items.
 */
export default function Loading() {
  return <PageSkeleton shape="detail" />;
}
