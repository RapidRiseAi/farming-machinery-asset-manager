import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white shadow-xs hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-600/50",
  secondary:
    "bg-white text-sand-800 border border-sand-300 shadow-xs hover:bg-sand-50 active:bg-sand-100 disabled:opacity-50",
  ghost:
    "bg-transparent text-sand-700 hover:bg-sand-100 active:bg-sand-200 disabled:opacity-50",
  danger:
    "bg-status-overdue text-white shadow-xs hover:bg-red-700 active:bg-red-800 disabled:bg-status-overdue/50",
};

// All sizes clear the 44px minimum tap target (Scope §7 / WCAG).
const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-[44px] px-3 text-sm gap-1.5",
  md: "min-h-[44px] px-4 text-sm gap-2",
  lg: "min-h-[48px] px-5 text-base gap-2",
};

/**
 * Class string for a button-styled element. Use it to style links as buttons,
 * e.g. `<Link className={buttonVariants({ variant: "primary" })}>`.
 */
export function buttonVariants({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex select-none items-center justify-center whitespace-nowrap rounded-lg font-medium",
    "transition-colors focus-ring disabled:cursor-not-allowed",
    VARIANTS[variant],
    SIZES[size],
    fullWidth && "w-full",
    className,
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

/**
 * Button. Server-compatible (no client hooks). For form-submit pending state
 * prefer `SubmitButton`, which reads `useFormStatus` automatically.
 */
export function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  loading = false,
  leftIcon,
  rightIcon,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonVariants({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading ? <Spinner className="text-[1.1em]" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}
