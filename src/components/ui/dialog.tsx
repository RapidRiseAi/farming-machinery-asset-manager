"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { CloseIcon } from "./icons";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Shared overlay: portal, backdrop, Esc-to-close, scroll lock, focus trap. */
function Overlay({
  open,
  onClose,
  labelledBy,
  describedBy,
  align,
  children,
  panelClassName,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  describedBy?: string;
  align: "center" | "bottom";
  children: ReactNode;
  panelClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    // Focus the first control (or the panel) once painted.
    const id = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.body.style.overflow = overflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex animate-fade-in",
        align === "center" ? "items-center justify-center p-4" : "items-end justify-center",
      )}
      onKeyDown={handleKeyDown}
    >
      <div
        className="absolute inset-0 bg-sand-950/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full bg-white shadow-pop outline-none",
          align === "center"
            ? "max-w-lg rounded-2xl animate-scale-in"
            : "max-h-[85vh] overflow-y-auto rounded-t-2xl pb-safe animate-slide-up",
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DialogHeader({
  title,
  titleId,
  onClose,
  closeLabel,
}: {
  title?: ReactNode;
  titleId: string;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-sand-100 px-5 py-3.5">
      <h2 id={titleId} className="text-base font-semibold text-sand-900">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="focus-ring -mr-1 flex h-10 w-10 items-center justify-center rounded-lg text-[1.35rem] text-sand-500 hover:bg-sand-100"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Accessible label for the close button (translated). */
  closeLabel?: string;
  children: ReactNode;
  /** Footer actions rendered in a bottom bar. */
  footer?: ReactNode;
  className?: string;
};

/** Centered modal dialog. Client component (focus trap, Esc, scroll lock). */
export function Modal({
  open,
  onClose,
  title,
  closeLabel = "Close",
  children,
  footer,
  className,
}: ModalProps) {
  const titleId = "modal-title";
  return (
    <Overlay
      open={open}
      onClose={onClose}
      align="center"
      labelledBy={title ? titleId : undefined}
      panelClassName={className}
    >
      {title ? (
        <DialogHeader title={title} titleId={titleId} onClose={onClose} closeLabel={closeLabel} />
      ) : null}
      <div className="px-5 py-4">{children}</div>
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-sand-100 px-5 py-3.5">{footer}</div>
      ) : null}
    </Overlay>
  );
}

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  closeLabel?: string;
  children: ReactNode;
  className?: string;
};

/** Bottom sheet (mobile-first). Client component. Used by the "More" nav menu. */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel = "Close",
  children,
  className,
}: SheetProps) {
  const titleId = "sheet-title";
  return (
    <Overlay
      open={open}
      onClose={onClose}
      align="bottom"
      labelledBy={title ? titleId : undefined}
      panelClassName={className}
    >
      {title ? (
        <DialogHeader title={title} titleId={titleId} onClose={onClose} closeLabel={closeLabel} />
      ) : (
        <div className="flex justify-center pt-2.5" aria-hidden>
          <span className="h-1.5 w-10 rounded-full bg-sand-300" />
        </div>
      )}
      <div className="px-4 py-3">{children}</div>
    </Overlay>
  );
}
