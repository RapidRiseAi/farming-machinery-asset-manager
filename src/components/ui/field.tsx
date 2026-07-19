import type { ReactNode } from "react";
import { cn } from "./cn";

export type FieldProps = {
  /** Visible label text. */
  label?: ReactNode;
  /** `id` of the control this label points at (wire `id` on the control too). */
  htmlFor?: string;
  /** Helper text shown below the control. */
  hint?: ReactNode;
  /** Error message; when set, styles the label and shows the message (role=alert). */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * Label + control + hint/error wrapper. Server-compatible. Give the control an
 * `id` matching `htmlFor`; when `error` is set, also set the control's
 * `aria-describedby` to `${htmlFor}-error` for AT users.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-sand-800">
          {label}
          {required ? (
            <span className="ml-0.5 text-status-overdue" aria-hidden>
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} role="alert" className="text-sm text-status-overdue">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-sand-500">{hint}</p>
      ) : null}
    </div>
  );
}
