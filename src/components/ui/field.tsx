import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";

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

// ── Labelled controls ────────────────────────────────────────────────────────
//
// The audit's fourth pattern: placeholder-as-label, ten times on the public QR page
// alone, plus both login email boxes, the contractor money fields and the parts inline
// editor. A placeholder disappears the moment you type — so the person least able to
// remember what the box was for is the one it fails.
//
// These three wrap Field + control so a labelled field is a one-liner and there is no
// reason left to reach for a bare placeholder. The id is derived from `name` (stable
// on the server, no `useId`, so these stay server components); pass `id` explicitly
// when the same name appears twice on one page.

function controlId(name: string | undefined, id: string | undefined): string | undefined {
  return id ?? (name ? `f-${name}` : undefined);
}

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: ReactNode;
  id?: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Wrapper class — the control itself takes `className`. */
  fieldClassName?: string;
};

/** A labelled text input. Use this instead of a bare `Input` with a placeholder. */
export function TextField({
  label,
  id,
  name,
  hint,
  error,
  required,
  fieldClassName,
  className,
  ...props
}: TextFieldProps) {
  const cid = controlId(name, id);
  return (
    <Field
      label={label}
      htmlFor={cid}
      hint={hint}
      error={error}
      required={required}
      className={fieldClassName}
    >
      <Input
        id={cid}
        name={name}
        required={required}
        invalid={!!error}
        aria-describedby={error && cid ? `${cid}-error` : undefined}
        className={className}
        {...props}
      />
    </Field>
  );
}

export type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: ReactNode;
  id?: string;
  hint?: ReactNode;
  error?: ReactNode;
  fieldClassName?: string;
  children: ReactNode;
};

/** A labelled select. */
export function SelectField({
  label,
  id,
  name,
  hint,
  error,
  required,
  fieldClassName,
  className,
  children,
  ...props
}: SelectFieldProps) {
  const cid = controlId(name, id);
  return (
    <Field
      label={label}
      htmlFor={cid}
      hint={hint}
      error={error}
      required={required}
      className={fieldClassName}
    >
      <Select id={cid} name={name} required={required} className={className} {...props}>
        {children}
      </Select>
    </Field>
  );
}

export type TextareaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  label: ReactNode;
  id?: string;
  hint?: ReactNode;
  error?: ReactNode;
  fieldClassName?: string;
};

/** A labelled textarea. */
export function TextareaField({
  label,
  id,
  name,
  hint,
  error,
  required,
  fieldClassName,
  className,
  ...props
}: TextareaFieldProps) {
  const cid = controlId(name, id);
  return (
    <Field
      label={label}
      htmlFor={cid}
      hint={hint}
      error={error}
      required={required}
      className={fieldClassName}
    >
      <Textarea id={cid} name={name} required={required} className={className} {...props} />
    </Field>
  );
}
