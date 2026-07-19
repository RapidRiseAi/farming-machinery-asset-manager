import type { TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

/** Multiline text input. Pair with `Field`. */
export function Textarea({ className, invalid, rows = 4, ...props }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        "block w-full rounded-lg border border-sand-300 bg-white px-3 py-2.5 text-base text-sand-900",
        "placeholder:text-sand-400 shadow-xs transition-colors",
        "focus:border-brand-500 focus-ring disabled:cursor-not-allowed disabled:bg-sand-100 disabled:opacity-70",
        "aria-[invalid=true]:border-status-overdue",
        className,
      )}
      {...props}
    />
  );
}
