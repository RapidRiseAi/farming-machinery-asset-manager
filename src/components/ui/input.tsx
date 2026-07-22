import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

// text-base (16px) avoids the iOS zoom-on-focus; min-h clears 44px tap target.
export const controlBase =
  "block w-full min-h-[44px] rounded-lg border border-sand-300 bg-white px-3 text-base text-sand-900 " +
  "placeholder:text-sand-400 shadow-xs transition-colors " +
  "focus:border-brand-500 focus-ring disabled:cursor-not-allowed disabled:bg-sand-100 disabled:opacity-70 " +
  "aria-[invalid=true]:border-status-overdue";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

/** Text input. Pair with `Field` for a label/hint/error. */
export function Input({ className, invalid, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(controlBase, className)}
      {...props}
    />
  );
}
