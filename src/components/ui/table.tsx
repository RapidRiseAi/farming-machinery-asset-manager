import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn";
import { ChevronUpIcon, ChevronDownIcon } from "./icons";

/**
 * Dense data table. `Table` provides a horizontal-scroll wrapper so wide tables
 * never break the mobile layout. Compose with `Thead/Tbody/Tr/Th/Td`.
 */
export function Table({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function Thead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-sand-200", className)} {...props} />;
}

export function Tbody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-sand-100", className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-sand-50", className)} {...props} />;
}

export type ThProps = ThHTMLAttributes<HTMLTableCellElement> & {
  /** Show a sort indicator; `null` = sortable but inactive. */
  sort?: "asc" | "desc" | null;
};

export function Th({ sort, className, children, ...props }: ThProps) {
  return (
    <th
      scope="col"
      aria-sort={sort === undefined ? undefined : sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none"}
      className={cn(
        "whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-sand-500 first:pl-4 last:pr-4",
        className,
      )}
      {...props}
    >
      {sort === undefined ? (
        children
      ) : (
        <span className="inline-flex items-center gap-1">
          {children}
          {sort === "asc" ? (
            <ChevronUpIcon className="text-[0.95rem]" />
          ) : sort === "desc" ? (
            <ChevronDownIcon className="text-[0.95rem]" />
          ) : (
            <ChevronDownIcon className="text-[0.95rem] text-sand-300" />
          )}
        </span>
      )}
    </th>
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("px-3 py-2.5 align-middle text-sand-800 first:pl-4 last:pr-4", className)}
      {...props}
    />
  );
}
