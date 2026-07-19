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
}: SubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonVariants({ variant, size, fullWidth, className })}
    >
      {pending ? <Spinner className="text-[1.1em]" /> : leftIcon}
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
