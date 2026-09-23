"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";
import { Overlay } from "./dialog";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { menuItemClass } from "./menu-item";
import { Disclosure } from "./disclosure";
import { CloseIcon } from "./icons";
import { cn } from "./cn";

/**
 * A form that lives in a dialog instead of on the page.
 *
 * == The problem this solves ==================================================
 * Counted across the app, capture forms were revealed in four different ways, and
 * three of them cost something:
 *
 *   · ALWAYS OPEN. `/settings` renders twenty-two fields and `/suppliers` its whole
 *     "add a supplier" form with no disclosure at all, so the list you came to read
 *     starts below a form you did not ask for.
 *   · A URL ROUND TRIP. `/tyres` and `/incidents` reveal a row's form by navigating
 *     to `?check=<id>`, so revealing fields costs a full server render, and the URL
 *     you are left holding reopens the form next time you land on it.
 *   · COLLAPSED BUT RENDERED. `/suppliers` puts each row's eight-field edit form in a
 *     `<details>`, so every row ships its form to the browser to keep it hidden.
 *   · A DIALOG, which is what `/jobcards` already does, correctly, and what the rest
 *     of this file makes cheap enough to use everywhere.
 *
 * The fix is not to remove fields. It is to stop showing them until they are asked
 * for, without a navigation: the page shows what IS, a button asks for what is NEW.
 *
 * == Why children are server-rendered =========================================
 * `children` is a `<form action={serverAction}>` built by the Server Component that
 * renders this dialog. React sends it as part of the RSC payload and this client
 * component only mounts it, so server actions, `Field`, `SubmitButton` and the
 * offline capture hooks all keep working exactly as they do inline. Nothing about a
 * form has to change to move into a dialog except where it is wrapped.
 *
 * == Why it closes itself =====================================================
 * Every server action in this app ends in `redirect("/tyres?saved=added")`. That is
 * a soft navigation: this component keeps its position in the tree, so React keeps
 * its state, so `open` stays true and the dialog sits there holding a stale form
 * over the row it just wrote. `DialogActions` watches `useFormStatus()` for the
 * pending edge and closes on the way down. An action that redirects with `?error=`
 * closes too, and the page's `<Flash>` reports it, which is where every other error
 * on this product is already read.
 */

type DialogFormState = { close: () => void; titleId: string };

const DialogFormContext = createContext<DialogFormState | null>(null);

/**
 * Lets anything inside the dialog close it, most usefully a Cancel button that is
 * rendered on the server, inside the form, and so cannot hold the open state itself.
 */
export function useDialogForm(): DialogFormState {
  const ctx = useContext(DialogFormContext);
  if (!ctx) {
    throw new Error("useDialogForm must be used inside a DialogForm.");
  }
  return ctx;
}

export type DialogFormProps = {
  /** Trigger label. */
  trigger: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  triggerFullWidth?: boolean;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  /** Accessible name for the trigger when its label is an icon only. */
  triggerLabel?: string;
  title: ReactNode;
  /** One line under the title saying what this form is for. */
  description?: ReactNode;
  closeLabel: string;
  /** `lg` for a two-column form, `md` for a handful of fields. */
  size?: "md" | "lg";
  /**
   * `menuItem` styles the trigger as a row in an `ActionMenu` instead of a button.
   *
   * Without this the two look like different kinds of thing stacked in one menu, and
   * `triggerClassName` cannot fix it: `cn` does not de-duplicate, so button padding
   * and menu-row padding would both land.
   */
  triggerLook?: "button" | "menuItem";
  triggerTone?: "default" | "danger";
  children: ReactNode;
};

/**
 * Trigger button + the dialog its form lives in.
 *
 * Bottom sheet on a phone (within thumb reach, which is the whole reason `Overlay`
 * has a responsive alignment) and a centred modal once there is a mouse.
 */
export function DialogForm({
  trigger,
  triggerVariant = "primary",
  triggerSize = "md",
  triggerFullWidth,
  triggerIcon,
  triggerClassName,
  triggerLabel,
  title,
  description,
  closeLabel,
  size = "lg",
  triggerLook = "button",
  triggerTone = "default",
  children,
}: DialogFormProps) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const titleId = `dialog-form-title-${uid}`;
  const descId = `dialog-form-desc-${uid}`;
  const close = useCallback(() => setOpen(false), []);
  const openDialog = () => setOpen(true);

  return (
    <>
      {triggerLook === "menuItem" ? (
        <button
          type="button"
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          onClick={openDialog}
          className={menuItemClass(triggerTone, triggerClassName)}
        >
          {triggerIcon}
          {trigger}
        </button>
      ) : (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          fullWidth={triggerFullWidth}
          leftIcon={triggerIcon}
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          className={triggerClassName}
          onClick={openDialog}
        >
          {trigger}
        </Button>
      )}

      <Overlay
        open={open}
        onClose={close}
        align="responsive"
        wide={size === "lg"}
        labelledBy={titleId}
        describedBy={description ? descId : undefined}
      >
        <DialogFormContext.Provider value={{ close, titleId }}>
          {/*
            Sticky rather than fixed: `Overlay`'s panel is the scroll container, so a
            long form scrolls under a header that keeps saying which form it is. On a
            phone that matters by field six.
          */}
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-sand-100 bg-surface px-5 py-3.5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-sand-900">
                {title}
              </h2>
              {description ? (
                <p id={descId} className="mt-0.5 text-sm text-sand-600">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={close}
              className="focus-ring -mr-1 inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-xl text-sand-500 hover:bg-sand-100 sm:min-h-[40px]"
            >
              <CloseIcon />
              <span className="text-sm font-medium">{closeLabel}</span>
            </button>
          </div>
          <div className="px-5 py-4">{children}</div>
        </DialogFormContext.Provider>
      </Overlay>
    </>
  );
}

/**
 * The dialog's action bar: Cancel, plus whatever submits.
 *
 * Must be rendered inside the `<form>`, because that is what makes `useFormStatus()`
 * report this form's submission and not some other form on the page.
 *
 * Sticky to the bottom of the scrolling panel so "Save" is reachable without scrolling
 * a seventeen-field form to its end first. The negative margins let it span the
 * dialog's full width while the form itself keeps its padding.
 */
export function DialogActions({
  children,
  cancelLabel,
  /** Left-aligned note, e.g. which fields are required. */
  note,
}: {
  children: ReactNode;
  cancelLabel: string;
  note?: ReactNode;
}) {
  const { close } = useDialogForm();
  const { pending } = useFormStatus();
  const wasPending = useRef(false);

  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (wasPending.current) {
      wasPending.current = false;
      close();
    }
  }, [pending, close]);

  return (
    <div className="sticky bottom-0 -mx-5 mt-1 flex flex-wrap items-center justify-end gap-2 border-t border-sand-100 bg-surface px-5 py-3">
      {note ? <p className="mr-auto text-xs text-sand-500">{note}</p> : null}
      <Button type="button" variant="ghost" onClick={close} disabled={pending}>
        {cancelLabel}
      </Button>
      {children}
    </div>
  );
}

/**
 * A named, collapsed group of fields inside a dialog form.
 *
 * == Why a dialog is not enough on its own ====================================
 * Moving `/incidents`' capture form into a dialog hides twenty-two fields behind a
 * button, which fixes the page and not the form: the dialog then opens onto the same
 * twenty-two fields. Only five of them are ever needed to record that a bakkie hit a
 * gate (which machine, what kind, when, where, what happened); the rest are the SAPS
 * reference, the other driver's insurer, and a claim that does not exist yet on the
 * day of the accident.
 *
 * So the required few stay open and the rest become sections. Nothing is removed and
 * nothing moves to another screen, which matters because the person filling this in
 * may well have all of it in front of them on an insurer's letter.
 *
 * Open it by default when a row being EDITED already has values in it, so an update
 * never hides data the person came to change.
 */
export function DialogSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="sm:col-span-2">
      <Disclosure summary={title} variant="inline" defaultOpen={defaultOpen}>
        <DialogFields className="pt-1">{children}</DialogFields>
      </Disclosure>
    </div>
  );
}

/** Grid for the fields inside a dialog form. One column on a phone, two from `sm`. */
export function DialogFields({
  children,
  columns = 2,
  className,
}: {
  children: ReactNode;
  columns?: 1 | 2;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3", columns === 2 && "sm:grid-cols-2", className)}>
      {children}
    </div>
  );
}
