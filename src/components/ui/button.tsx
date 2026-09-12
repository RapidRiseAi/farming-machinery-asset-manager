import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./icons";

export type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white shadow-xs hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-600/50",
  /**
   * The FleetWise Gold call to action.
   *
   * Note `text-sand-950` and not white: black on gold is 9.89:1, white on gold
   * is 2.12:1 and fails. That is the ONLY correct way to render a gold button,
   * and `design_lint` fails the build on the white variant.
   *
   * Use it sparingly — the brand rule is "keep gold deliberate so it remains
   * visually important". At most one per screen, on the action you actually
   * want taken; everything else stays `primary` or `secondary`.
   */
  accent:
    "bg-gold-500 text-accent-on-fill shadow-xs hover:bg-gold-400 active:bg-gold-600 active:text-white disabled:bg-gold-500/50",
  secondary:
    "bg-surface text-sand-800 border border-sand-300 shadow-xs hover:bg-sand-50 active:bg-sand-100 disabled:opacity-50",
  ghost:
    "bg-transparent text-sand-700 hover:bg-sand-100 active:bg-sand-200 disabled:opacity-50",
  /**
   * Destructive. The ink flips WITH the fill — white on the deep red in light
   * (6.68:1), black on the lighter red in dark (6.34:1). A fixed `text-white`
   * would drop to 1.92:1 the moment the fill lightened for a dark surface.
   */
  danger:
    "bg-dangerSolid text-dangerSolid-ink shadow-xs hover:bg-dangerSolid-hover active:bg-dangerSolid-hover disabled:bg-dangerSolid/50",
};

/**
 * 48px minimum on a phone, 40–44px on desktop where there is a mouse. These users are
 * outdoors, in sunlight, often with dirty or gloved hands — the mobile figure is the
 * one that matters, so every size steps DOWN at `sm`, never up.
 */
/**
 * 48px is the floor on a phone, for every size — a dense secondary action is still
 * pressed by the same thumb, in the same sunlight, with the same dust on the glass.
 * `sm` therefore differs from `md` only once there is a mouse: the sizes step DOWN at
 * `sm:`, they never step down on the device that needs them big.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-[48px] sm:min-h-[36px] px-3 text-sm gap-1.5",
  md: "min-h-[48px] sm:min-h-[40px] px-4 text-sm gap-2",
  lg: "min-h-[52px] sm:min-h-[44px] px-5 text-base gap-2",
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
