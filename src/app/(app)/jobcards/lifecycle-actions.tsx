"use client";

import { useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Modal } from "@/components/ui/dialog";
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
  const noMeter = meterReading == null;

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="primary" onClick={() => setConfirm("complete")}>
        {t("jobcards.markCompleted", locale)}
      </Button>
      {canApprove ? (
        <Button type="button" variant="secondary" onClick={() => setConfirm("approve")}>
          {t("jobcards.approveLock", locale)}
        </Button>
      ) : null}

      <Modal
        open={confirm === "complete"}
        onClose={() => setConfirm(null)}
        title={t("jobcards.confirmComplete", locale)}
        closeLabel={t("jobcards.cancel", locale)}
      >
        <p className="text-sm text-sand-600">{t("jobcards.confirmCompleteBody", locale)}</p>
        {noMeter ? <p className="mt-2 text-sm text-status-overdue">{t("jobcards.meterRequired", locale)}</p> : null}
        <form action={completeJobCard} className="mt-4 flex justify-end gap-2">
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
