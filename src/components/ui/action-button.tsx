"use client";

import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./button";
import { useSingleFlight } from "./use-single-flight";
import type { ActionLabels } from "@/lib/interaction-labels";

export type ActionButtonProps = Omit<ButtonProps, "onClick" | "loading" | "type"> & {
  /** The work. Taps while it runs are ignored; a throw is reported and shown. */
  onAction: () => Promise<unknown>;
  /** Names this control in error reports, e.g. "statements:send". */
  where: string;
  /** From `actionLabels(locale)`, translated on the server. */
  labels: ActionLabels;
  /** Replaces the default failure sentence when this action has a more useful one. */
  failedMessage?: string;
  /** Called after a failure is reported, for a caller that also resets its own state. */
  onError?: (error: unknown) => void;
  /** Optional label while the work runs. */
  pendingText?: ReactNode;
};

/**
 * A button that runs async work: once per tap, never twice at a time, spinner while it
 * runs, and a failure that is reported and told to the person instead of vanishing.
 *
 * For a `<form>` that posts a server action, use `SubmitButton`; this is for everything a
 * button does in its own `onClick`: a fetch, a server action called directly, a share.
 */
export function ActionButton({
  onAction,
  where,
  labels,
  failedMessage,
  onError,
  pendingText,
  disabled,
  children,
  ...props
}: ActionButtonProps) {
  const { run, busy } = useSingleFlight(onAction, {
    where,
    failed: { message: failedMessage ?? labels.failed, offline: labels.offline, closeLabel: labels.dismiss },
    onError,
  });
  return (
    <Button {...props} type="button" loading={busy} disabled={disabled} onClick={() => void run()}>
      {busy && pendingText ? pendingText : children}
      {busy && !pendingText ? <span className="sr-only">{labels.working}</span> : null}
    </Button>
  );
}
