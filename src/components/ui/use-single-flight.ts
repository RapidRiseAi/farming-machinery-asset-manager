"use client";

import { useCallback, useRef, useState } from "react";
import { reportClientError } from "@/lib/client-report";
import { showNotice } from "@/lib/notice";
import { asError, isNavigationSignal } from "@/lib/single-flight";

/**
 * After a failure the lock stays a moment longer: taps queued behind the failed attempt
 * would otherwise each run, fail and report again. A deliberate retry is still welcome.
 */
const AFTER_FAILURE_MS = 1000;

export type SingleFlightOptions = {
  /** Names the control in error reports, e.g. "jobcards:send-quote". */
  where: string;
  /**
   * What to tell the person when the work throws, translated. `offline` replaces the
   * message when the browser knows it has no connection, which is the usual cause here.
   * Omit both to handle failure yourself through `onError`.
   */
  failed?: { message: string; offline?: string; closeLabel?: string };
  /** Called after the failure is reported, for a control that shows its own message. */
  onError?: (error: unknown) => void;
};

/**
 * Run async work from a tap, once at a time, with every failure reported and shown.
 *
 * `run` ignores calls while the last one is still running (see `createSingleFlight` for
 * why the lock is a ref and not state); `busy` is for the spinner and `disabled`. When
 * the work throws, the error is reported with `where` and the person is told, unless it
 * is Next's redirect signal from a server action: that is rethrown untouched, because
 * Next performs the navigation when it receives it.
 */
export function useSingleFlight<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
  { where, failed, onError }: SingleFlightOptions,
) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const failedMessage = failed?.message;
  const offlineMessage = failed?.offline;
  const closeLabel = failed?.closeLabel;

  const run = useCallback(
    async (...args: A) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      let hold = 0;
      try {
        await fn(...args);
      } catch (error) {
        if (isNavigationSignal(error)) throw error;
        hold = AFTER_FAILURE_MS;
        reportClientError(asError(error), where);
        if (failedMessage) {
          const offline = typeof navigator !== "undefined" && navigator.onLine === false;
          showNotice({ tone: "error", message: offline && offlineMessage ? offlineMessage : failedMessage, closeLabel });
        }
        onError?.(error);
      } finally {
        setBusy(false);
        if (hold) {
          window.setTimeout(() => {
            running.current = false;
          }, hold);
        } else {
          running.current = false;
        }
      }
    },
    [fn, where, failedMessage, offlineMessage, closeLabel, onError],
  );

  return { run, busy };
}
