"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

/**
 * A dialog or row menu that knows when something inside it is being saved.
 *
 * `SubmitButton` locks its own form while the post is out, and that was the whole lock.
 * The container around it stayed live: Close, the backdrop and Escape all worked mid-save,
 * and closing UNMOUNTED the form, so reopening the dialog gave a fresh, unlocked button
 * while the first request was still running. On a slow phone that is exactly what people
 * do with a dialog that looks stuck: close it, open it, save again. Two expenses, two
 * fuel deliveries, two payments. The same for sibling rows in one menu: each row is its
 * own form, so "Acknowledge" and then "Resolve" could both be sent.
 *
 * So every `SubmitButton` reports its pending state to the nearest container. While any
 * report is pending the container is busy: it refuses to close, and every submit button
 * and close control in it (`data-pending-lock`) is disabled. A container inside another
 * (a dialog opened from a row menu) passes its state outward, and hears the outer one's
 * lock back, so neither can close under the other. `onSettle` runs when the last pending
 * report clears, for containers that close then.
 *
 * == Why refs and the DOM, not state ========================================
 * The first version kept `busy` in React state. Setting it re-rendered the container
 * mid-save, and the components inside the form that re-rendered with it (through a
 * context) read React's DEFAULT form status, not pending, because the form itself had
 * not re-rendered. `DialogActions` took that for "settled" and closed the dialog 100 ms
 * into the save, the very thing this exists to stop (caught in a real browser by
 * scripts/spam_check.mjs). So nothing here changes React state or context while a save is
 * out: the lock lives in refs, and the buttons are disabled directly in the DOM, which
 * React leaves alone because their props do not change.
 */
type PendingGuard = {
  report: (id: string, pending: boolean) => void;
  /** This container busy, or any container around it. */
  isLocked: () => boolean;
  /** Called whenever `isLocked()` may have changed. */
  subscribe: (listener: () => void) => () => void;
};

const PendingGuardContext = createContext<PendingGuard | null>(null);

const LOCKABLE = 'button[type="submit"], [data-pending-lock]';

export function usePendingContainer(onSettle?: () => void) {
  const parent = useContext(PendingGuardContext);
  const selfId = useId();
  const pendingIds = useRef(new Set<string>());
  /** Read by close handlers: true while anything in this container is saving. */
  const busyRef = useRef(false);
  /** The element whose controls are locked; a `display: contents` wrapper is enough. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const disabledHere = useRef(new Set<HTMLButtonElement>());
  const listeners = useRef(new Set<() => void>());
  const settle = useRef(onSettle);
  const parentRef = useRef(parent);
  useEffect(() => {
    settle.current = onSettle;
    parentRef.current = parent;
  });

  const isLocked = useCallback(() => busyRef.current || (parentRef.current?.isLocked() ?? false), []);

  /** Disable every enabled lockable control under the root, or give back what it took. */
  const apply = useCallback(() => {
    const root = rootRef.current;
    if (isLocked()) {
      if (!root) return;
      for (const control of root.querySelectorAll<HTMLButtonElement>(LOCKABLE)) {
        if (control.disabled) continue;
        control.disabled = true;
        disabledHere.current.add(control);
      }
    } else {
      for (const control of disabledHere.current) control.disabled = false;
      disabledHere.current.clear();
    }
    for (const listener of listeners.current) listener();
  }, [isLocked]);

  const report = useCallback(
    (id: string, pending: boolean) => {
      const ids = pendingIds.current;
      const was = ids.size > 0;
      if (pending) ids.add(id);
      else ids.delete(id);
      const now = ids.size > 0;
      if (was === now) return;
      busyRef.current = now;
      apply();
      parentRef.current?.report(selfId, now);
      if (was && !now) settle.current?.();
    },
    [apply, selfId],
  );

  // Hear the lock of the container around this one.
  useEffect(() => parent?.subscribe(apply), [parent, apply]);
  // A container that goes away mid-save must not leave its parent locked for good.
  useEffect(() => () => parentRef.current?.report(selfId, false), [selfId]);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<PendingGuard>(() => ({ report, isLocked, subscribe }), [report, isLocked, subscribe]);
  return { busyRef, rootRef, value };
}

export function PendingGuardProvider({ value, children }: { value: PendingGuard; children: ReactNode }) {
  return <PendingGuardContext.Provider value={value}>{children}</PendingGuardContext.Provider>;
}

/**
 * Sibling forms that must not run together, with no dialog around them: "Pay now" (which
 * charges the stored card) and "Replace card" side by side on /billing.
 */
export function PendingGroup({ children }: { children: ReactNode }) {
  const { rootRef, value } = usePendingContainer();
  return (
    <PendingGuardProvider value={value}>
      <div ref={rootRef} className="contents">
        {children}
      </div>
    </PendingGuardProvider>
  );
}

/** For a control whose form is posting: tells the nearest container. */
export function useReportPending(pending: boolean): void {
  const guard = useContext(PendingGuardContext);
  const id = useId();
  const report = guard?.report;
  useEffect(() => {
    report?.(id, pending);
  }, [report, id, pending]);
  useEffect(() => () => report?.(id, false), [report, id]);
}

/**
 * `useReportPending` as an element, for a component that renders its own dialog: placed
 * inside the form, it reports to that dialog rather than to whatever surrounds the
 * component. For forms that send with their own `fetch`, which React never sees as pending.
 */
export function ReportPending({ pending }: { pending: boolean }) {
  useReportPending(pending);
  return null;
}
