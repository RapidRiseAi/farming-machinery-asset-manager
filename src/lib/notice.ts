/**
 * Say something to the person from anywhere in the browser: a failed download, an action
 * that did not go through. One `<NoticeHost/>` in the root layout listens and shows it as
 * a toast just above the phone's tab bar.
 *
 * A DOM event rather than a React context, so a component needs no provider above it and
 * the host costs every page one listener. The message arrives already translated: the
 * host is in the root layout, and importing the dictionaries there would put them in the
 * bundle every page loads first.
 */
export type NoticeTone = "success" | "error" | "warning" | "info";

export type Notice = {
  tone: NoticeTone;
  /** Already translated. */
  message: string;
  /** The dismiss button's word, translated; the host falls back to its own. */
  closeLabel?: string;
};

export const NOTICE_EVENT = "fw:notice";

export function showNotice(notice: Notice): void {
  try {
    window.dispatchEvent(new CustomEvent<Notice>(NOTICE_EVENT, { detail: notice }));
  } catch {
    /* no window (server) or no CustomEvent: there is nobody to tell */
  }
}

/** How long a notice stays up: errors until read, confirmations briefly. */
export function noticeDuration(tone: NoticeTone): number {
  return tone === "error" || tone === "warning" ? 12_000 : 5_000;
}
