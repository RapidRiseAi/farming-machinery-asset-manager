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
   * Post the enclosing form to a DIFFERENT server action.
   *
   * This is what lets one form offer two ways in — sign in with a password, or have a link
   * emailed — while asking for the address once. Without it the page needs two forms and
   * two email boxes.
   */
  formAction?: (formData: FormData) => void | Promise<void>;
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
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonVariants({ variant, size, fullWidth, className })}
    >
      {pending ? <Spinner className="text-[1.1em]" /> : leftIcon}
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
