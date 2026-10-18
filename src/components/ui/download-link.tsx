"use client";

import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Spinner } from "./icons";
import { reportClientError } from "@/lib/client-report";
import { classifyDownload, DOWNLOAD_HEADER, filenameFromDisposition, filenameFromHref } from "@/lib/download";
import type { DownloadLabels } from "@/lib/interaction-labels";
import { showNotice } from "@/lib/notice";
import { asError } from "@/lib/single-flight";

/** Longer than any file route here takes, shorter than a person will wait. */
const TIMEOUT_MS = 120_000;
/** Taps that land just after the file saved are the frantic ones from before it did. */
const AFTER_SAVE_MS = 1500;
/**
 * After a failure, a moment before another attempt: the taps queued behind the failed one
 * would otherwise each fetch, fail and report again. A deliberate retry is still welcome.
 */
const AFTER_FAILURE_MS = 1000;
/** iPhone home-screen app: the browser downloads natively, so repeats are held this long. */
const NATIVE_LOCK_MS = 8000;

export type DownloadLinkProps = {
  href: string;
  /** From `downloadLabels(locale)`, translated on the server. */
  labels: DownloadLabels;
  className?: string;
  children: ReactNode;
  /** Used only when the server names no file. */
  filename?: string;
  /** Names this link in error reports; defaults to the route. */
  where?: string;
};

/**
 * A link to a file: one download per tap however often it is tapped, and a sentence
 * instead of a broken file when it fails.
 *
 * Every file route here (PDFs, CSVs, the workbook, exports) answers with an attachment.
 * As a plain link, each tap on a slow connection started another download and another
 * server render of the same file, and a failure arrived as the file: an expired session
 * saved the login page as `statement.pdf`. This fetches the file itself, ignores taps
 * while it does, checks what came back (`classifyDownload`), and saves it under the
 * server's name. The real `href` and `download` stay on the link, so it works before
 * the page's scripts have loaded and "open in new tab" still does.
 *
 * On an iPhone home-screen app, saving a fetched file is unreliable, so there the
 * browser downloads it natively as before and only the repeats are held back.
 */
export function DownloadLink({ href, labels, className, children, filename, where }: DownloadLinkProps) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);

  const release = (afterMs: number) => {
    setBusy(false);
    window.setTimeout(() => {
      lock.current = false;
    }, afterMs);
  };

  const onClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    // A new tab, a new window, a saved link: the browser's own job.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (lock.current) {
      event.preventDefault();
      return;
    }
    lock.current = true;
    setBusy(true);

    if (isIosHomeScreenApp()) {
      // Native download; the link is not prevented. Hold repeats for a while.
      window.setTimeout(() => {
        setBusy(false);
        lock.current = false;
      }, NATIVE_LOCK_MS);
      return;
    }

    event.preventDefault();
    const report = where ?? `download:${pathOf(href)}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    let cooldown = AFTER_FAILURE_MS;
    try {
      const res = await fetch(href, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { [DOWNLOAD_HEADER]: "1" },
        signal: controller.signal,
      });
      const failure = classifyDownload({
        ok: res.ok,
        status: res.status,
        redirected: res.redirected,
        url: res.url,
        contentType: res.headers.get("content-type"),
      });
      if (failure) {
        // Signed out, not allowed, gone, too busy: states, not faults. Only a real failure is reported.
        if (failure === "failed") reportClientError(new Error(`Download failed with ${res.status}`), report);
        showNotice({ tone: "error", message: labels[failure], closeLabel: labels.dismiss });
        return;
      }
      const blob = await res.blob();
      save(blob, filenameFromDisposition(res.headers.get("content-disposition"), filename ?? filenameFromHref(href)));
      cooldown = AFTER_SAVE_MS;
    } catch (error) {
      const offline = navigator.onLine === false;
      if (!offline) reportClientError(asError(error), report);
      showNotice({ tone: "error", message: offline ? labels.offline : labels.failed, closeLabel: labels.dismiss });
    } finally {
      window.clearTimeout(timer);
      release(cooldown);
    }
  };

  return (
    <a
      href={href}
      download
      className={className}
      onClick={(event) => void onClick(event)}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
    >
      {busy ? <Spinner className="text-[1.1em]" /> : null}
      {children}
      {busy ? <span className="sr-only">{labels.preparing}</span> : null}
    </a>
  );
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Not at once: some browsers read the URL after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** iOS Safari's own flag for an app opened from the home screen. */
function isIosHomeScreenApp(): boolean {
  return typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function pathOf(href: string): string {
  try {
    return new URL(href, window.location.href).pathname;
  } catch {
    return href.split("?")[0];
  }
}
