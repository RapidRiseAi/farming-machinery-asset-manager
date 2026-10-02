"use client";

import { useState } from "react";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import type { MutationScope, MutationType } from "@/lib/offline/types";
import { CheckIcon } from "@/components/ui/icons";

/**
 * Wraps a server-action form so that, when offline, the submit is intercepted and queued
 * to IndexedDB (idempotency UUID + client timestamp) with an optimistic confirm instead of
 * failing. Online, the native server action runs unchanged. Used for readings (app + QR),
 * job-card lines and job completion, captures without media.
 *
 * The confirmation says plainly that the capture is on this phone and sends itself when
 * there is signal, and it stays until the person starts the next one. It used to be one
 * small line that vanished after 2.5 seconds over a cleared form, which read as "my
 * reading is gone". `confirmMs` (above 0) still hides it on a timer for a caller that
 * wants that.
 */
export function OfflineForm({
  action,
  type,
  scope = "app",
  locale,
  className,
  children,
  onQueued,
  confirmMs = 0,
}: {
  action: (formData: FormData) => void | Promise<void>;
  type: MutationType;
  scope?: MutationScope;
  locale: Lang;
  className?: string;
  children: React.ReactNode;
  onQueued?: () => void;
  confirmMs?: number;
}) {
  const [queued, setQueued] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    // Online (or no IndexedDB) → let the server action submit normally.
    if (isOnline() || !canQueueOffline()) return;
    e.preventDefault();
    const form = e.currentTarget;
    const fields = fieldsFromForm(form);
    setSaveError(false);
    try { await queueMutation({ type, scope, fields }); }
    catch { setSaveError(true); return; }
    form.reset();
    setQueued(true);
    onQueued?.();
    if (confirmMs > 0) window.setTimeout(() => setQueued(false), confirmMs);
  };

  return (
    <form action={action} onSubmit={onSubmit} onInput={queued ? () => setQueued(false) : undefined} className={className}>
      {children}
      {saveError ? <p role="alert" className="text-sm text-status-overdue">{t("offline.storageFailed", locale)}</p> : null}
      {queued ? (
        <div role="status" className="mt-1 flex w-full items-start gap-3 rounded-xl border border-sand-200 bg-callout-warn-bg p-3 text-callout-warn-ink">
          <span className="mt-0.5 shrink-0 text-xl text-status-due" aria-hidden><CheckIcon /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{t("offline.savedOnPhone", locale)}</span>
            <span className="block text-sm">{t("offline.savedOffline", locale)}</span>
            <Link href="/queue" className="focus-ring mt-1 inline-flex min-h-[48px] items-center rounded text-sm font-medium underline sm:min-h-[36px]">
              {t("offline.review", locale)}
            </Link>
          </span>
        </div>
      ) : null}
    </form>
  );
}
