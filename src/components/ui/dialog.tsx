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
import { useScrollMemory } from "./use-scroll-memory";

// `input:not([type="hidden"])` matters more than it looks. Almost every ConfirmDialog
// passes its payload as `<input type="hidden">` children, so without that clause the
// first "focusable" in the panel was a hidden input: `.focus()` on it does nothing,
// focus stayed on the TRIGGER, outside the portal, and two things followed. The modal
// never received focus at all (a keyboard or screen-reader user was left behind it), and
// Escape did nothing, because the keydown fired outside the portal subtree and never
// reached this component's handler. Measured in a browser: dialog open, focus still on
// the page behind it, Escape → still open.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Scroll lock, counted rather than saved and restored per overlay.
 *
 * == Why a counter ============================================================
 * Each Overlay used to snapshot `document.body.style.overflow` on open and write the
 * snapshot back on close. With one overlay that is correct. With two it is a race,
 * because the restores are order-dependent: the inner dialog saves "hidden" (the value
 * the outer one just set) and hands it back, so the LAST restore to run decides, and
 * nothing guarantees which that is.
 *
 * Measured on `/tyres`: open a row's action menu, open a dialog inside it, submit. The
 * server action redirects, so the page remounts while the menu is still open; the
 * menu's cleanup restored "" and the dialog's then restored "hidden", in that order.
 * Both dialogs were gone and `document.body` was left `overflow: hidden`, so the page
 * could not be scrolled again until a reload. The clean path (cancel the inner, then
 * close the menu) happened to unwind in the opposite order and looked fine, which is
 * why this survived: the bug only appears when a navigation does the unmounting.
 *
 * Counting makes it order-independent. The first overlay to open locks and remembers
 * the page's own value; whichever one closes last brings the count to zero and puts
 * that value back. Module scope is correct here, it is per browser tab.
 */
let openOverlays = 0;
let pageOverflow = "";

function lockScroll() {
  if (openOverlays === 0) {
    pageOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  openOverlays += 1;
}

function releaseScroll() {
  // Floored: a double release would otherwise make the count negative and the next
  // lock would never reach zero again, which is the same bug with a longer fuse.
  openOverlays = Math.max(0, openOverlays - 1);
  if (openOverlays === 0) document.body.style.overflow = pageOverflow;
}

/** Shared overlay: portal, backdrop, Esc-to-close, scroll lock, focus trap. */
export function Overlay({
  open,
  onClose,
  labelledBy,
  describedBy,
  align,
  wide = false,
  rememberKey,
  children,
  panelClassName,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  describedBy?: string;
  /** "responsive" = bottom sheet within thumb reach on a phone, centred modal from `sm` up. */
  align: "center" | "bottom" | "responsive";
  /**
   * Widen the desktop panel from `max-w-lg` to `max-w-2xl`, for a two-column form.
   *
   * A prop rather than a `panelClassName` override because `cn` does not de-duplicate
   * conflicting Tailwind utilities: passing `sm:max-w-2xl` alongside the built-in
   * `sm:max-w-lg` leaves BOTH in the class list and lets whichever Tailwind happens to
   * emit later win. That is a coin toss dressed as a width.
   */
  wide?: boolean;
  /**
   * Remember how far this panel was scrolled, for the tab session, and restore it the
   * next time it opens. The panel IS the scroller for a bottom sheet (`max-h-[85vh]
   * overflow-y-auto`), and it mounts fresh on every open, so without this a 943px nav
   * sheet reopens at the top every single time. Measured: `943 -> 0`.
   */
  rememberKey?: string;
  children: ReactNode;
  panelClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Keyed on `open` so the restore runs on each open, and on nothing while closed
  // (the panel is not in the DOM then, and a closed sheet has no offset to keep).
  useScrollMemory(panelRef, open && mounted ? rememberKey : undefined);

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
    lockScroll();
    // Focus the first thing worth typing in, never the button that commits the action.
    // A dialog that opens with focus already on "Write it off" is one stray Enter away
    // from writing off an invoice, so a confirm-only dialog focuses the panel instead
    // (which is the WAI-ARIA pattern, and keeps Escape inside the portal either way).
    const id = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const visible = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      const field = visible.find(
        (el) => !(el instanceof HTMLButtonElement) && !(el instanceof HTMLAnchorElement),
      );
      // `preventScroll` only where a remembered offset exists to protect. Focusing an
      // element scrolls it into view, and this timeout runs AFTER the layout effect
      // that restored the offset, so without it the focus call would quietly undo the
      // restore and the sheet would open at the top anyway. Left on elsewhere, because
      // a dialog with a field below the fold SHOULD scroll to show it.
      (field ?? panel).focus(rememberKey ? { preventScroll: true } : undefined);
    }, 0);
    return () => {
      window.clearTimeout(id);
      releaseScroll();
      restoreRef.current?.focus?.();
    };
  }, [open, rememberKey]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex animate-fade-in",
        align === "center" && "items-center justify-center p-4",
        align === "bottom" && "items-end justify-center",
        align === "responsive" && "items-end justify-center sm:items-center sm:p-4",
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
          "relative z-10 w-full bg-surface shadow-pop outline-none",
          align === "center" && "max-w-lg rounded-2xl animate-scale-in",
          align === "bottom" &&
            "max-h-[85vh] overflow-y-auto rounded-t-2xl pb-safe animate-slide-up",
          align === "responsive" &&
            "max-h-[90vh] overflow-y-auto rounded-t-2xl pb-safe animate-slide-up sm:max-h-[85vh] sm:rounded-2xl sm:pb-0 sm:animate-scale-in",
          // Exactly one desktop width utility reaches the class list, so there is
          // nothing for Tailwind's emission order to arbitrate.
          align === "responsive" && (wide ? "sm:max-w-2xl" : "sm:max-w-lg"),
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
        className="focus-ring -mr-1 inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-xl text-sand-500 hover:bg-sand-100 sm:min-h-[40px]"
      >
        <CloseIcon />
        {/* Icon and word, the lone ✕ is the one glyph this product does not rely on. */}
        <span className="text-sm font-medium">{closeLabel}</span>
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
  /** See `Overlay.rememberKey`: keeps the sheet's scroll offset between opens. */
  rememberKey?: string;
};

/** Bottom sheet (mobile-first). Client component. Used by the "More" nav menu. */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel = "Close",
  children,
  className,
  rememberKey,
}: SheetProps) {
  const titleId = "sheet-title";
  return (
    <Overlay
      open={open}
      onClose={onClose}
      align="bottom"
      labelledBy={title ? titleId : undefined}
      panelClassName={className}
      rememberKey={rememberKey}
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
