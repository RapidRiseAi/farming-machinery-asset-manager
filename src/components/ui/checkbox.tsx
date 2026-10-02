/**
 * A labelled checkbox row, server-compatible.
 *
 *   <Checkbox name="email_alerts" defaultChecked={prefs.email} label={t(LABEL_KEY, locale)}
 *     hint={t(HINT_KEY, locale)} />
 *
 * Props: `label`, `hint?` (a second, quieter line), `className?` (the row), plus every
 * native checkbox prop (`name`, `value`, `defaultChecked`, `checked`, `onChange`,
 * `disabled`, `required`, `id`, `form`, ...), forwarded to the `<input>`. Pass `id`
 * as well and the hint is wired up as the box's description.
 *
 * == Why ======================================================================
 * Twenty-seven files hand-rolled a checkbox row, each about 34px tall, under the 48px
 * floor a thumb needs. On /notifications a long two-line label in an `items-start` row
 * without `shrink-0` squeezed the box itself, so "Email me these alerts too" had a
 * visibly smaller box than the two above it. Here the whole row is the target (48px on
 * a phone, 40px from `sm:`), the box is a fixed 20px that never shrinks, and it takes
 * the brand green through `accent-color`, so it stays a native control (keyboard,
 * forms, no-JS) in both themes.
 */
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  label: ReactNode;
  hint?: ReactNode;
  /** Classes for the row (the `<label>`). */
  className?: string;
};

export function Checkbox({ label, hint, className, id, disabled, ...input }: CheckboxProps) {
  const hintId = id && hint ? `${id}-hint` : undefined;
  return (
    <label
      className={cn(
        "flex min-h-[48px] gap-3 py-2 sm:min-h-[40px]",
        hint ? "items-start" : "items-center",
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
        className,
      )}
    >
      <input
        type="checkbox"
        id={id}
        disabled={disabled}
        aria-describedby={hintId}
        className={cn(
          "focus-ring h-5 w-5 shrink-0 rounded border-sand-300 accent-brand-600",
          hint ? "mt-0.5" : undefined,
        )}
        {...input}
      />
      <span className="min-w-0">
        <span className="block break-words text-sm font-medium text-sand-900">{label}</span>
        {hint ? (
          <span id={hintId} className="mt-0.5 block break-words text-xs text-sand-500">
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}
