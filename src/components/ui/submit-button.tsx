"use client";

import { useFormStatus } from "react-dom";
import { useId, type ReactNode } from "react";
import { buttonVariants, type ButtonVariant, type ButtonSize } from "./button";
import { Spinner } from "./icons";

/**
 * The hidden field every SubmitButton posts so it can recognise its own submission.
 *
 * Server actions read named fields, so an extra one is inert. It is namespaced to make
 * that obvious to anyone reading a request body.
 */
export const PRESSED_FIELD = "__pressed";

/**
 * Was THIS button the one that submitted the form?
 *
 * Exported and pure so the rule has a test. `useFormStatus().data` is the FormData being
 * submitted, and the browser includes the name/value of whichever submit button activated
 * the form, so the button whose own pair is in that data is the button that was pressed.
 *
 * Returns false for a null `data`, which covers both "nothing is in flight" and a
 * submission React could not serialise. That is the quiet answer rather than the loud one:
 * a button that never spins is a smaller failure than every button spinning.
 */
export function isOwnSubmission(
  data: FormData | null | undefined,
  fieldName: string,
  fieldValue: string,
): boolean {
  if (data == null) return false;
  return data.get(fieldName) === fieldValue;
}

export type SubmitButtonProps = {
  children: ReactNode;
  /** Optional label shown while the form is submitting. */
  pendingText?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  className?: string;
  disabled?: boolean;
  /**
   * Post this form to a DIFFERENT server action.
   *
   * Lets one form offer two ways forward without duplicating its fields. The
   * login screen used to stack two whole forms, each with its own box labelled
   * "Email", so choosing the second one meant typing your address twice.
   */
  formAction?: (formData: FormData) => void | Promise<void>;
  /** Skip HTML validation for this submission (a secondary path may need less). */
  formNoValidate?: boolean;
  name?: string;
  value?: string;
};

/**
 * Submit button wired to `useFormStatus`: shows a spinner and disables itself while its
 * own submission is in flight. Must be a descendant of the `<form>` it submits.
 *
 * == Why it does not simply use `pending` =====================================
 * `useFormStatus()` reports the state of the FORM, not of the button, so every
 * SubmitButton inside one form saw the same `pending` and every one of them started
 * spinning. On the login screen that meant pressing "Sign in" also set "Email me a link"
 * spinning, which reads as though both were happening and leaves somebody watching two
 * animations wondering which one they actually started. Reported from the live site.
 *
 * The fix is for each button to POST ITS OWN NAME. `useFormStatus().data` is the FormData
 * being submitted, and a `<button name value>` that triggers a submission contributes its
 * pair to that data. So a button is busy only when the data carries its own id: one
 * spinner, on the control that was pressed.
 *
 * A caller that passes its own `name`/`value` (several do, to tell the server which row a
 * button belongs to) keeps them and is matched on those instead, so nothing is overwritten.
 *
 * Note that the browser includes the name/value of whichever submit button activated the
 * form, including the first one when somebody presses Enter in a text field. That is the
 * right answer there too: Enter submits the primary action, and the primary button spins.
 */
export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  size = "md",
  fullWidth,
  leftIcon,
  className,
  disabled,
  formAction,
  formNoValidate,
  name,
  value,
}: SubmitButtonProps) {
  const uid = useId();
  const status = useFormStatus();
  const { pending, data } = status;

  // A caller's own name/value wins; otherwise this button identifies itself.
  const fieldName = name ?? PRESSED_FIELD;
  const fieldValue = value ?? uid;

  // Two ways to recognise your own submission, because a button with a `formAction`
  // CANNOT use the first. React encodes the action into the button's name attribute and
  // warns "Cannot specify a name prop for a button that specifies a function as a
  // formAction... It will get overridden", so the marker never reaches the browser and
  // that button would silently never spin. Caught by measuring the rendered DOM, not by
  // reading the code.
  //
  // For those, `useFormStatus().action` is the action being submitted, and comparing it
  // against this button's own `formAction` identifies it exactly. Two buttons sharing one
  // formAction would both spin; they would also both be doing the same thing.
  const isMine = formAction
    ? status.action === formAction
    : isOwnSubmission(data, fieldName, fieldValue);
  const busy = pending && isMine;

  return (
    <button
      type="submit"
      // Still disabled by the FORM's pending state, not only by its own. A second
      // submission while the first is in flight is a double charge waiting to happen, so
      // every button in the form stops accepting presses; only the pressed one animates.
      disabled={disabled || pending}
      aria-busy={busy || undefined}
      formAction={formAction}
      formNoValidate={formNoValidate}
      // Omitted entirely when there is a formAction: React overrides it there, and passing
      // it anyway is a console warning on every render for an attribute that never lands.
      name={formAction ? name : fieldName}
      value={formAction ? value : fieldValue}
      className={buttonVariants({ variant, size, fullWidth, className })}
    >
      {busy ? <Spinner className="text-[1.1em]" /> : leftIcon}
      {busy && pendingText ? pendingText : children}
    </button>
  );
}
