import type { SelectHTMLAttributes } from "react";
import { cn } from "./cn";
import { controlBase } from "./input";
import { ChevronDownIcon } from "./icons";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
};

/** Styled native `<select>` with a chevron affordance. Pair with `Field`. */
export function Select({ className, invalid, children, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cn(controlBase, "cursor-pointer appearance-none pr-10", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[1.15rem] text-sand-500"
      />
    </div>
  );
}
