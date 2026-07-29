"use client";

import { useState, type InputHTMLAttributes } from "react";
import { cn } from "./cn";
import { controlBase } from "./input";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** Localized accessible label for the reveal button (e.g. "Hold to show password"). */
  revealLabel?: string;
};

/**
 * Password input with a HOLD-TO-REVEAL button (deliberately NOT a toggle): the
 * characters are shown only while the eye button is actively pressed — via pointer
 * or keyboard — and hidden again the instant it is released, so a field is never
 * left readable to someone glancing at the screen.
 */
export function PasswordInput({
  className,
  invalid,
  revealLabel = "Hold to show password",
  ...props
}: Props) {
  const [shown, setShown] = useState(false);
  const show = () => setShown(true);
  const hide = () => setShown(false);

  return (
    <div className="relative">
      <input
        {...props}
        type={shown ? "text" : "password"}
        aria-invalid={invalid || undefined}
        className={cn(controlBase, "pr-12", className)}
      />
      <button
        type="button"
        aria-label={revealLabel}
        aria-pressed={shown}
        title={revealLabel}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          show();
        }}
        onPointerUp={hide}
        onPointerCancel={hide}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            show();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            hide();
          }
        }}
        onBlur={hide}
        className="focus-ring absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-sand-500 hover:text-sand-800"
      >
        {shown ? <EyeOffGlyph /> : <EyeGlyph />}
      </button>
    </div>
  );
}

function EyeGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function EyeOffGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-3.3 4.1M6.1 6.1A17.6 17.6 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 3.3-.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
