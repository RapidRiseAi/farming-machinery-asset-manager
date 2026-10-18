"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-report";
import { createReportGate, shouldReport } from "@/lib/client-error-filter";

/**
 * Reports every uncaught error in the browser, not only the ones that crash a screen.
 *
 * Error boundaries already report a render that throws. Everything else went nowhere: a
 * click handler whose promise rejected, a script that threw after load, a fetch nobody
 * caught. On a farm phone those are exactly the failures that look like "the button does
 * nothing", and nobody hears about them. This listens for both kinds of uncaught error
 * and sends what `shouldReport` keeps, each distinct error once per page load.
 *
 * It reports; it does not show anything. What the person sees on a failure is the job of
 * the control that failed (`ActionButton`, `DownloadLink`, a form's own message).
 */
export function ClientErrorReporter() {
  useEffect(() => {
    const allow = createReportGate();

    const send = (error: unknown, where: string, source?: string) => {
      const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
      const digest = (error as { digest?: unknown } | null)?.digest;
      const candidate = {
        message: err.message,
        stack: err.stack,
        source,
        name: err.name,
        digest: typeof digest === "string" ? digest : undefined,
      };
      if (!shouldReport(candidate) || !allow(candidate)) return;
      reportClientError(err, where);
    };

    const onError = (event: ErrorEvent) => {
      send(event.error ?? event.message, "window-error", event.filename);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      send(event.reason, "unhandled-rejection");
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
