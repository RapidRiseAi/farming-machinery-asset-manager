"use client";

import type { ReactNode } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ButtonVariant, ButtonSize } from "@/components/ui/button";

/**
 * A form whose submit is gated by a native confirm() dialog — for destructive,
 * irreversible actions (e.g. POPIA erasure). `children` holds the hidden inputs
 * carrying the action's payload. The server action is passed in as `action`.
 */
export function ConfirmForm({
  action,
  message,
  label,
  children,
  variant = "danger",
  size = "sm",
  className,
}: {
  action: (formData: FormData) => void | Promise<void>;
  message: string;
  label: ReactNode;
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <form
      action={action}
      className={className}
      onSubmit={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
      <SubmitButton variant={variant} size={size}>
        {label}
      </SubmitButton>
    </form>
  );
}
