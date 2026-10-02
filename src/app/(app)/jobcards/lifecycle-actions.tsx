"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Modal } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import { completeJobCard, approveJobCard, changeJobCardStatus, returnJobCard } from "./actions";

export function LifecycleActions({
  id, status, updatedAt, meterReading, meterRequired, hasWorkPerformed, needsServiceSelection, canWork, canApprove, canReturn, correctionHistoryAvailable, locale,
}: {
  id: string; status: string; updatedAt: string; meterReading: number | null; meterRequired: boolean;
  hasWorkPerformed: boolean; canWork: boolean; canApprove: boolean; locale: Lang;
  canReturn: boolean;
  correctionHistoryAvailable: boolean;
  needsServiceSelection: boolean;
}) {
  const [confirm, setConfirm] = useState<null | "complete" | "approve" | "return">(null);
  const [queued, setQueued] = useState(false);
  const [queueError, setQueueError] = useState(false);
  const searchParams = useSearchParams();
  useEffect(() => { setConfirm(null); }, [status, searchParams]);
  const needsMeter = meterRequired && meterReading == null;
  const canComplete = canWork && status === "in_progress";
  const review = status === "completed";
  const nextStatus = status === "in_progress" ? "waiting_parts" : "in_progress";
  const transitionLabel = status === "waiting_parts" ? "resumeWork" : status === "in_progress" ? "waitForParts" : "startWork";

  const onCompleteSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    if (isOnline() || !canQueueOffline()) return;
    event.preventDefault();
    try {
      await queueMutation({ type: "complete_job", scope: "app", fields: fieldsFromForm(event.currentTarget) });
      setConfirm(null);
      setQueued(true);
    } catch { setQueueError(true); }
  };

  return (
    <div className="flex flex-col gap-3">
      {canComplete && (needsMeter || !hasWorkPerformed || needsServiceSelection) ? (
        <p role="status" className="rounded-lg bg-callout-warn-bg px-3 py-2.5 text-sm text-sand-700">
          {t("jobcards.beforeFinish", locale)} {needsMeter ? t("jobcards.needMeterOut", locale) : ""} {!hasWorkPerformed ? t("jobcards.workflow.needWork", locale) : ""} {needsServiceSelection ? t("jobcards.workflow.selectTasks", locale) : ""}
        </p>
      ) : null}
      {review && !canApprove ? <p className="text-sm text-sand-600">{t("jobcards.workflow.awaitReview", locale)}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {canWork ? (
          <form action={changeJobCardStatus}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="updated_at" value={updatedAt} />
            <input type="hidden" name="status" value={nextStatus} />
            <SubmitButton variant={status === "in_progress" ? "secondary" : "primary"}>{t(`jobcards.workflow.${transitionLabel}`, locale)}</SubmitButton>
          </form>
        ) : null}
        {canComplete ? <Button type="button" variant="primary" disabled={needsMeter || !hasWorkPerformed || queued} onClick={() => setConfirm("complete")}>{t("jobcards.jobDone", locale)}</Button> : null}
        {review && canApprove ? (
          <>
            <Button type="button" variant="primary" onClick={() => setConfirm("approve")}>{t("jobcards.approveLock", locale)}</Button>
            {canReturn ? <Button type="button" variant="secondary" onClick={() => setConfirm("return")}>{t("jobcards.workflow.returnWork", locale)}</Button> : <p className="text-sm text-sand-600">{t(correctionHistoryAvailable ? "jobcards.workflow.billedReview" : "jobcards.workflow.historicalReview", locale)}</p>}
          </>
        ) : null}
      </div>
      {queued ? <p role="status" className="text-sm text-status-due">{t("offline.savedOffline", locale)}</p> : null}
      {queueError ? <p role="alert" className="text-sm text-status-overdue">{t("jobcards.workflow.queueFailed", locale)}</p> : null}

      <Modal open={confirm === "complete"} onClose={() => setConfirm(null)} title={t("jobcards.confirmComplete", locale)} closeLabel={t("common.cancel", locale)}>
        <p className="text-sm text-sand-600">{t("jobcards.workflow.completeHint", locale)}</p>
        <form action={completeJobCard} onSubmit={onCompleteSubmit} className="mt-4 flex justify-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="updated_at" value={updatedAt} />
          <input type="hidden" name="meter_reading" value={meterReading ?? ""} />
          <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>{t("common.cancel", locale)}</Button>
          <SubmitButton variant="primary" disabled={needsMeter || !hasWorkPerformed}>{t("jobcards.markCompleted", locale)}</SubmitButton>
        </form>
      </Modal>
      <Modal open={confirm === "approve"} onClose={() => setConfirm(null)} title={t("jobcards.confirmApprove", locale)} closeLabel={t("common.cancel", locale)}>
        <p className="text-sm text-sand-600">{t("jobcards.workflow.approveHint", locale)}</p>
        <form action={approveJobCard} className="mt-4 flex justify-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="updated_at" value={updatedAt} />
          <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>{t("common.cancel", locale)}</Button>
          <SubmitButton variant="primary">{t("jobcards.approveLock", locale)}</SubmitButton>
        </form>
      </Modal>
      <Modal open={confirm === "return"} onClose={() => setConfirm(null)} title={t("jobcards.workflow.returnWork", locale)} closeLabel={t("common.cancel", locale)}>
        <form action={returnJobCard} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="updated_at" value={updatedAt} />
          <Field label={t("jobcards.workflow.returnReason", locale)} htmlFor="return-reason" required>
            <Textarea id="return-reason" name="reason" required minLength={3} rows={3} />
          </Field>
          <SubmitButton variant="primary">{t("jobcards.workflow.returnWork", locale)}</SubmitButton>
        </form>
      </Modal>
    </div>
  );
}
