import Link from "next/link";

// The paging arithmetic lives in a plain module so the server and the tests can use it
// without loading a component.
export { PAGE_SIZE, pageNumber, pageRange } from "@/lib/paging";

/**
 * Newer and older links under a list ordered newest first. Renders nothing when everything
 * fits on the first page. Links are 48px tall, the same touch target as the faults list.
 */
export function Pager({
  page,
  hasOlder,
  href,
  label,
  newerLabel,
  olderLabel,
}: {
  page: number;
  hasOlder: boolean;
  href: (page: number) => string;
  label: string;
  newerLabel: string;
  olderLabel: string;
}) {
  if (page <= 1 && !hasOlder) return null;
  const link = "focus-ring inline-flex min-h-[48px] items-center rounded px-3 underline";
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3">
      {page > 1 ? <Link className={link} href={href(page - 1)}>{newerLabel}</Link> : <span />}
      {hasOlder ? <Link className={link} href={href(page + 1)}>{olderLabel}</Link> : null}
    </nav>
  );
}
