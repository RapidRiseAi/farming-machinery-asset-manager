"use client";

import { useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import type { MutationScope, MutationType } from "@/lib/offline/types";

/**
 * Wraps a server-action form so that, when offline, the submit is intercepted and queued
 * to IndexedDB (idempotency UUID + client timestamp) with an optimistic confirm instead of
 * failing. Online, the native server action runs unchanged. Used for readings (app + QR),
 * job-card lines and job completion — captures without media.
 */
export function OfflineForm({
  action,
  type,
  scope = "app",
  locale,
  className,
  children,
  onQueued,
  confirmMs = 2500,
}: {
  action: (formData: FormData) => void | Promise<void>;
  type: MutationType;
  scope?: MutationScope;
  locale: Locale;
  className?: string;
  children: React.ReactNode;
  onQueued?: () => void;
  confirmMs?: number;
}) {
  const [queued, setQueued] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    // Online (or no IndexedDB) → let the server action submit normally.
    if (isOnline() || !canQueueOffline()) return;
    e.preventDefault();
    const form = e.currentTarget;
    const fields = fieldsFromForm(form);
    await queueMutation({ type, scope, fields });
    form.reset();
    setQueued(true);
    onQueued?.();
    window.setTimeout(() => setQueued(false), confirmMs);
  };

  return (
    <form action={action} onSubmit={onSubmit} className={className}>
      {children}
      {queued ? (
        <p role="status" className="mt-1 text-sm font-medium text-status-due">
          ✓ {t("offline.savedOffline", locale)}
        </p>
      ) : null}
    </form>
  );
}
