"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { Overlay } from "./dialog";
import { Button } from "./button";
import { CloseIcon, MoreIcon } from "./icons";

/**
 * The actions for one row, behind one button.
 *
 * == The problem this solves ==================================================
 * A list row in this product tended to carry every action it could ever need, all
 * visible at once. An open row on `/faults` renders five separate `<form>`s, one each
 * for raise-a-job-card, acknowledge, start, assign and resolve, and the assign form
 * carries a `<Select>` listing every active user on the farm. Eight open faults is
 * forty controls and eight copies of the staff list, so the row's actual CONTENT,
 * which machine, how urgent, how long it has been stopped, is the smallest thing on
 * the row and the eye has nowhere to rest.
 *
 * == Why a sheet and not an anchored dropdown =================================
 * Two reasons, and the second is the one that decided it.
 *
 * 1. Anchored positioning needs measurement, flipping near the viewport edge, and a
 *    scroll listener, and it gets all three wrong on a phone often enough to matter.
 *    A sheet has no geometry to get wrong.
 * 2. An anchored dropdown drops the row context. It opens next to the row, so it
 *    cannot say which row it belongs to, and a mis-tap on "Remove" is discovered
 *    afterwards. This takes a `title`, so the panel names the machine or the tyre it
 *    is about, above the action that will change it.
 *
 * Bottom sheet within thumb reach on a phone, centred panel once there is a mouse,
 * which is `Overlay`'s responsive alignment and matches every other dialog here.
 *
 * == It does not close on click ===============================================
 * Deliberately. A menu row is often a `DialogForm` trigger, and those are rendered
 * on the server INSIDE this menu's children. Closing on click would unmount the
 * trigger together with the dialog it just opened. So this closes on Escape, on the
 * backdrop, and on its own close button; a nested dialog portals above it and, when
 * dismissed, reveals the menu again with focus back on the row that opened it.
 */

export type ActionMenuProps = {
  /** Names the row the actions belong to, e.g. the machine or tyre. */
  title: ReactNode;
  /** Accessible name for the trigger, which is an icon on a row. */
  label: string;
  closeLabel: string;
  /** Trigger text. Omit for the icon-only `...` button a dense row wants. */
  trigger?: ReactNode;
  /**
   * `"bare"` renders the trigger as a plain `<button>` carrying `triggerClassName`
   * and nothing else, for the one caller that is not a row action: the sidebar's
   * account row, which is a full-width left-aligned block with an avatar in it.
   *
   * A `triggerClassName` on the default look could not express that. `cn` does not
   * de-duplicate conflicting Tailwind utilities, so `w-full justify-start` handed to
   * a `Button` that already says `justify-center` leaves BOTH in the class list and
   * lets emission order decide the alignment. Same reasoning as `DialogForm`'s
   * `triggerLook`.
   */
  triggerLook?: "button" | "bare";
  triggerClassName?: string;
  children: ReactNode;
};

export function ActionMenu({
  title,
  label,
  closeLabel,
  trigger,
  triggerLook = "button",
  triggerClassName,
  children,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const titleId = `action-menu-title-${uid}`;
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      {triggerLook === "bare" ? (
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className={triggerClassName}
        >
          {trigger}
        </button>
      ) : (
        <Button
          type="button"
          variant={trigger ? "secondary" : "ghost"}
          size="sm"
          aria-label={trigger ? undefined : label}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className={trigger ? undefined : "px-2"}
        >
          {trigger ?? <MoreIcon />}
        </Button>
      )}

      <Overlay open={open} onClose={close} align="responsive" labelledBy={titleId}>
        <div className="flex items-center justify-between gap-3 border-b border-sand-100 px-5 py-3.5">
          <h2 id={titleId} className="min-w-0 truncate text-base font-semibold text-sand-900">
            {title}
          </h2>
          <button
            type="button"
            onClick={close}
            className="focus-ring -mr-1 inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-xl text-sand-500 hover:bg-sand-100 sm:min-h-[40px]"
          >
            <CloseIcon />
            <span className="text-sm font-medium">{closeLabel}</span>
          </button>
        </div>
        {/*
          `[&>*]:w-full` so a caller can drop a Link, a SubmitButton or a DialogForm
          trigger in and get one column of equal-width rows without each call site
          repeating the layout. Server Components render the rows; this only stacks them.
        */}
        <div className="flex flex-col gap-1.5 px-4 py-3 [&>*]:w-full [&>form]:contents">
          {children}
        </div>
      </Overlay>
    </>
  );
}

/** A non-interactive label that groups the rows under it. */
export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-sand-500">
      {children}
    </p>
  );
}
