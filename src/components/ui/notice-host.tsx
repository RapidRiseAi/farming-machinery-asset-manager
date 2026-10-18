"use client";

import { useCallback, useEffect, useState } from "react";
import { Toast } from "./toast";
import { NOTICE_EVENT, noticeDuration, type Notice } from "@/lib/notice";

/** More than this and the oldest goes: a stack of toasts hides the page they are about. */
const MAX_SHOWN = 3;

/**
 * Shows what `showNotice()` says, from anywhere in the app. One instance, in the root
 * layout, so the signed-out pages (login, the public document page) have it too.
 *
 * Same place and look as the billing confirmation toast: fixed just above the phone's tab
 * bar, overlaying the page rather than pushing it down. The same message twice is shown
 * once; a button tapped five times during a failure should not stack five apologies.
 */
export function NoticeHost({ closeLabel }: { closeLabel: string }) {
  const [notices, setNotices] = useState<Array<Notice & { id: number }>>([]);

  useEffect(() => {
    let next = 0;
    const onNotice = (event: Event) => {
      const notice = (event as CustomEvent<Notice>).detail;
      if (!notice || typeof notice.message !== "string" || !notice.message) return;
      setNotices((current) => {
        if (current.some((shown) => shown.message === notice.message)) return current;
        next += 1;
        return [...current, { ...notice, id: next }].slice(-MAX_SHOWN);
      });
    };
    window.addEventListener(NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(NOTICE_EVENT, onNotice);
  }, []);

  const dismiss = useCallback((id: number) => setNotices((current) => current.filter((shown) => shown.id !== id)), []);

  if (notices.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 pb-safe lg:bottom-6">
      {notices.map((notice) => (
        <NoticeToast key={notice.id} notice={notice} closeLabel={closeLabel} onGone={dismiss} />
      ))}
    </div>
  );
}

/**
 * One notice. Its own component so the dismiss callback keeps one identity for the life of
 * the toast: `Toast` restarts its timer when that callback changes, so an inline arrow
 * would restart every toast's countdown each time another notice arrived.
 */
function NoticeToast({
  notice,
  closeLabel,
  onGone,
}: {
  notice: Notice & { id: number };
  closeLabel: string;
  onGone: (id: number) => void;
}) {
  const { id } = notice;
  const gone = useCallback(() => onGone(id), [onGone, id]);
  return (
    <Toast
      tone={notice.tone}
      message={notice.message}
      duration={noticeDuration(notice.tone)}
      closeLabel={notice.closeLabel ?? closeLabel}
      onDismissed={gone}
      className="pointer-events-auto w-full max-w-md"
    />
  );
}
