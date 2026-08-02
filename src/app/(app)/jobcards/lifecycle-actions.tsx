"use client";

import { useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Modal } from "@/components/ui/dialog";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import { completeJobCard, approveJobCard } from "./actions";

export function LifecycleActions({
  id,
  meterReading,
  canApprove,
  locale,
}: {
  id: string;
  meterReading: number | null;
  canApprove: boolean;
  locale: Locale;
}) {
  const [confirm, setConfirm] = useState<null | "complete" | "approve">(null);
  const [queued, setQueued] = useState(false);
  const noMeter = meterReading == null;

  // Offline: queue the completion locally (idempotent replay) instead of failing.
  const onCompleteSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    if (isOnline() || !canQueueOffline()) return; // online → native server action
    e.preventDefault();
    await queueMutation({ type: "complete_job", scope: "app", fields: fieldsFromForm(e.currentTarget) });
    setConfirm(null);
    setQueued(true);
    window.setTimeout(() => setQueued(false), 3000);
  };

  return (
    <div className="flex flex-col gap-3">
      {/*
        The requirement is visible BEFORE you try. It used to be discoverable only by
        being blocked: "Mark completed" opened a modal and then disabled its own confirm
        button with a red line of text.
      */}
      {noMeter ? (
        <p className="flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-status-due">
          <span className="font-semibold">{t("jobcards.beforeFinish", locale)}</span>
          <span className="text-sand-700">{t("jobcards.needMeterOut", locale)}</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="lg"
          disabled={noMeter}
          onClick={() => setConfirm("complete")}
        >
          {t("jobcards.jobDone", locale)}
        </Button>
        {canApprove ? (
          <Button type="button" variant="secondary" size="lg" onClick={() => setConfirm("approve")}>
            {t("jobcards.approveLock", locale)}
          </Button>
        ) : null}
        {queued ? (
          <p role="status" className="text-sm font-medium text-status-due">✓ {t("offline.savedOffline", locale)}</p>
        ) : null}
      </div>

      <Modal
        open={confirm === "complete"}
        onClose={() => setConfirm(null)}
        title={t("jobcards.confirmComplete", locale)}
        closeLabel={t("jobcards.cancel", locale)}
      >
        <p className="text-sm text-sand-600">{t("jobcards.confirmCompleteBody", locale)}</p>
        <form action={completeJobCard} onSubmit={onCompleteSubmit} className="mt-4 flex justify-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="meter_reading" value={meterReading ?? ""} />
          <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>{t("jobcards.cancel", locale)}</Button>
          <SubmitButton variant="primary" disabled={noMeter}>{t("jobcards.markCompleted", locale)}</SubmitButton>
        </form>
      </Modal>

      <Modal
        open={confirm === "approve"}
        onClose={() => setConfirm(null)}
        title={t("jobcards.confirmApprove", locale)}
        closeLabel={t("jobcards.cancel", locale)}
      >
        <p className="text-sm text-sand-600">{t("jobcards.confirmApproveBody", locale)}</p>
        <form action={approveJobCard} className="mt-4 flex justify-end gap-2">
          <input type="hidden" name="id" value={id} />
          <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>{t("jobcards.cancel", locale)}</Button>
          <SubmitButton variant="primary">{t("jobcards.approveLock", locale)}</SubmitButton>
        </form>
      </Modal>
    </div>
  );
}
