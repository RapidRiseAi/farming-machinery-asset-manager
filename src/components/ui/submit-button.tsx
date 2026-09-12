"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
import { buttonVariants, type ButtonVariant, type ButtonSize } from "./button";
import { Spinner } from "./icons";

export type SubmitButtonProps = {
  children: ReactNode;
  /** Optional label shown while the form is submitting. */
  pendingText?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  className?: string;
  disabled?: boolean;
  /**
   * Post this form to a DIFFERENT server action.
   *
   * Lets one form offer two ways forward without duplicating its fields — the
   * login screen used to stack two whole forms, each with its own box labelled
   * "Email", so choosing the second one meant typing your address twice.
   */
  formAction?: (formData: FormData) => void | Promise<void>;
  /** Skip HTML validation for this submission (a secondary path may need less). */
  formNoValidate?: boolean;
  name?: string;
  value?: string;
};

/**
 * Submit button wired to `useFormStatus` — shows a spinner and disables itself
 * while the enclosing `<form action={...}>` server action is pending. Must be a
 * descendant of the `<form>` it submits.
 */
export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  size = "md",
  fullWidth,
  leftIcon,
  className,
  disabled,
  formAction,
  formNoValidate,
  name,
  value,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      formAction={formAction}
      formNoValidate={formNoValidate}
      name={name}
      value={value}
      className={buttonVariants({ variant, size, fullWidth, className })}
    >
      {pending ? <Spinner className="text-[1.1em]" /> : leftIcon}
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
