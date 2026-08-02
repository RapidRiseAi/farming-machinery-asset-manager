"use client";

import { useId, useState, type ReactNode } from "react";
import { Overlay } from "./dialog";
import { Button, buttonVariants, type ButtonVariant, type ButtonSize } from "./button";
import { SubmitButton } from "./submit-button";
import { cn } from "./cn";
import { WarningIcon } from "./icons";

export type ConfirmTone = "danger" | "brand";

/** One "quote R14,200 · bill R14,200" style row inside the dialog body. */
export type ConfirmFact = { label: string; value: string; hint?: string };

export type ConfirmDialogProps = {
  /** The server action the confirm button submits. Never wrapped or renamed. */
  action: (formData: FormData) => void | Promise<void>;
  /** Hidden inputs carrying the action's payload — rendered inside the form. */
  children?: ReactNode;

  /** Trigger button (the thing on the page before anything opens). */
  triggerLabel: ReactNode;
  triggerIcon?: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  triggerFullWidth?: boolean;
  triggerClassName?: string;

  /** Plain-language question, e.g. "Delete Rooi Massey 385?" */
  title: string;
  /** One sentence saying what this does, in the farm's own words. */
  intro?: string;
  /** Figures worth seeing side by side before deciding (amounts, quote vs bill). */
  facts?: ConfirmFact[];
  /** What is lost / what happens the moment they press it. */
  consequencesTitle?: string;
  consequences?: string[];
  /** Reassurance under the consequences — e.g. "the work itself stays". */
  footnote?: ReactNode;

  /**
   * When set, the confirm button stays disabled until the user types this string
   * exactly. Reserved for the irreversible (POPIA erasure).
   */
  typeToConfirm?: string;
  typeToConfirmLabel?: string;
  typeToConfirmPlaceholder?: string;

  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmTone;
  closeLabel?: string;
};

/**
 * The one confirmation step in the product (audit Part 1, bugs 4 + 5).
 *
 * A plain-language question, a statement of what will actually happen, an optional
 * type-to-confirm for the irreversible, and an escape that reads as the easy way out.
 * Bottom sheet on a phone (thumb reach), centred modal from `sm` up.
 *
 * The server action, its field names and its redirect are untouched — this only puts
 * a deliberate step in front of the submit.
 */
export function ConfirmDialog({
  action,
  children,
  triggerLabel,
  triggerIcon,
  triggerVariant = "danger",
  triggerSize = "md",
  triggerFullWidth,
  triggerClassName,
  title,
  intro,
  facts,
  consequencesTitle,
  consequences,
  footnote,
  typeToConfirm,
  typeToConfirmLabel,
  typeToConfirmPlaceholder,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  closeLabel = "Close",
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const introId = useId();
  const typeId = useId();

  const locked = !!typeToConfirm && typed.trim() !== typeToConfirm;

  function close() {
    setOpen(false);
    setTyped("");
  }

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        fullWidth={triggerFullWidth}
        className={triggerClassName}
        leftIcon={triggerIcon}
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>

      <Overlay
        open={open}
        onClose={close}
        align="responsive"
        labelledBy={titleId}
        describedBy={intro ? introId : undefined}
      >
        <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden>
          <span className="h-1.5 w-10 rounded-full bg-sand-300" />
        </div>

        <div className="px-5 pb-4 pt-4">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[1.3rem]",
                tone === "danger" ? "bg-red-50 text-red-700" : "bg-brand-50 text-brand-700",
              )}
              aria-hidden
            >
              <WarningIcon />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xl font-bold tracking-tight text-sand-900">
                {title}
              </h2>
              {intro ? (
                <p id={introId} className="mt-1.5 text-[0.95rem] leading-relaxed text-sand-600">
                  {intro}
                </p>
              ) : null}
            </div>
          </div>

          {facts && facts.length > 0 ? (
            <dl className="mt-4 divide-y divide-sand-100 rounded-xl border border-sand-200 bg-sand-50">
              {facts.map((f) => (
                <div key={f.label} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                  <dt className="text-sm text-sand-600">{f.label}</dt>
                  <dd className="text-right">
                    <span className="text-base font-semibold tabular-nums text-sand-900">
                      {f.value}
                    </span>
                    {f.hint ? <span className="block text-xs text-sand-500">{f.hint}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {consequences && consequences.length > 0 ? (
            <div className="mt-4">
              {consequencesTitle ? (
                <h3 className="text-sm font-semibold text-sand-800">{consequencesTitle}</h3>
              ) : null}
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {consequences.map((c) => (
                  <li key={c} className="flex gap-2 text-sm leading-relaxed text-sand-600">
                    <span aria-hidden className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-sand-400" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {footnote ? <div className="mt-3 text-sm text-sand-500">{footnote}</div> : null}

          <form action={action} className="mt-5 flex flex-col gap-2.5">
            {children}

            {typeToConfirm ? (
              <div className="mb-1">
                <label htmlFor={typeId} className="block text-sm font-medium text-sand-800">
                  {typeToConfirmLabel}
                </label>
                <input
                  id={typeId}
                  type="text"
                  value={typed}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={typeToConfirmPlaceholder}
                  className="mt-1.5 min-h-[48px] w-full rounded-lg border border-sand-300 bg-white px-3 text-base text-sand-900 placeholder:text-sand-400 focus-ring"
                />
              </div>
            ) : null}

            <SubmitButton
              variant={tone === "danger" ? "danger" : "primary"}
              size="lg"
              fullWidth
              disabled={locked}
            >
              {confirmLabel}
            </SubmitButton>
            <button
              type="button"
              onClick={close}
              className={buttonVariants({ variant: "ghost", size: "lg", fullWidth: true })}
            >
              {cancelLabel}
            </button>
            <span className="sr-only">{closeLabel}</span>
          </form>
        </div>
      </Overlay>
    </>
  );
}
