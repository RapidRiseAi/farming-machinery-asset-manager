import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn";
import { ChevronUpIcon, ChevronDownIcon } from "./icons";

/**
 * Dense data table.
 *
 * == Two ways to survive a phone, and when to use which ======================
 * A table of six or more columns does not fit 360px, and this product is read standing
 * next to a truck. There are two honest answers and the kit supports both:
 *
 *   · `stacked` (this file). Each row becomes a small card below `lg`, with every cell
 *     labelled by its column. Nothing is hidden, nothing scrolls sideways, and the page
 *     keeps ONE set of markup. Use it for a table whose cells are mostly text.
 *   · A hand-written card list beside `hidden lg:block` on the table, which is what
 *     `/machines` and `/jobcards` do. Costs a second layout, and is worth it when the
 *     mobile view wants a different SHAPE rather than the same cells restacked: a photo,
 *     a headline, and two badges is not six labelled rows.
 *
 * The one thing that is NOT an answer is the default horizontal scroller. It leaves the
 * first column visible and everything that matters off-screen to the right, with no clue
 * that there is more, which is how a farmer concludes a figure is missing.
 *
 * == How the stacking works ==================================================
 * `display: block` on the table parts below `lg`, and each `Td` renders its column name
 * from a `label` prop. A real `<th scope="col">` stays in the DOM in both modes, so the
 * table is still a table to a screen reader; the labels are `aria-hidden` repeats for
 * the eye, which is why `Th` must keep carrying the column name even when stacked.
 */
export function Table({
  stacked = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLTableElement> & {
  /** Restack each row as a labelled card below `lg`. Pair with `label` on every `Td`. */
  stacked?: boolean;
}) {
  return (
    /*
     * A stacked table still needs the scroller ONCE IT IS A TABLE AGAIN.
     *
     * Dropping the wrapper outright looked right, because below `lg` a stacked table is
     * a column of cards that cannot overflow. It is wrong from `lg` up, where it goes
     * back to being a real table with its columns: measured at a 1024px laptop, `/team`
     * laid out an 823px table inside a 687px column and pushed the whole DOCUMENT to
     * 1112px, so the page scrolled sideways. `lg:overflow-x-auto` gives it back the
     * scroll container exactly where it becomes a table.
     *
     * Not applied below `lg`: `overflow-x` forces `overflow-y` to compute to `auto`
     * too, and there is no reason to introduce a clipping context around the cards.
     */
    <div className={cn(stacked ? "lg:overflow-x-auto" : "-mx-4 overflow-x-auto sm:mx-0")}>
      <table
        data-stacked={stacked ? "" : undefined}
        className={cn("w-full border-collapse text-left text-sm", className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

export function Thead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("border-b border-edge", className)}
      {...props}
    />
  );
}

export function Tbody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  // divide-sand-100 measured 1.03:1 against the card surface in the dark theme -
  // the row separators were invisible and long lists read as one block.
  return (
    <tbody
      className={cn("divide-y divide-edge-soft", className)}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn("transition-colors hover:bg-surface-hover", className)}
      {...props}
    />
  );
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
        "whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-muted first:pl-4 last:pr-4",
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
            <ChevronUpIcon className="text-base" />
          ) : sort === "desc" ? (
            <ChevronDownIcon className="text-base" />
          ) : (
            <ChevronDownIcon className="text-base text-ink-subtle" />
          )}
        </span>
      )}
    </th>
  );
}

export type TdProps = TdHTMLAttributes<HTMLTableCellElement> & {
  /**
   * The column's name, shown beside this cell when the table is `stacked`.
   *
   * Required in practice on a stacked table: without it a phone shows a column of bare
   * values with nothing saying which is the date and which is the amount.
   */
  label?: string;
};

export function Td({ label, className, children, ...props }: TdProps) {
  return (
    <td
      className={cn("px-3 py-2.5 align-middle text-ink first:pl-4 last:pr-4", className)}
      {...props}
    >
      {label ? (
        <span
          aria-hidden
          data-cell-label
          className="hidden shrink-0 text-xs font-medium uppercase tracking-wide text-ink-muted"
        >
          {label}
        </span>
      ) : null}
      {/*
        `display: contents` by default, so this wrapper is invisible to layout and every
        table that is NOT stacked renders exactly as it did: a cell holding a div, a form
        or a button row is unaffected, which an ordinary inline span would not have been.
        The stacked media query turns it into a real box so the value can sit right of
        its label.
      */}
      <span data-cell-value className="contents">
        {children}
      </span>
    </td>
  );
}
