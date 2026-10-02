"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Modal } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { CheckIcon, SquareIcon } from "@/components/ui/icons";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import { completeJobCard, approveJobCard, changeJobCardStatus, returnJobCard } from "./actions";

/**
 * The job's next move: one or two buttons, and, before it can be finished, a short list
 * of what is still missing with a way to fix each item where it is listed.
 *
 * It used to say "Before finishing: write what was done. Add the meter reading." in one
 * stitched sentence above a greyed-out button, which told a mechanic the button was dead
 * without telling them where to go. The rules are unchanged: work performed and (where the
 * machine has a meter) the handover reading are required; service tasks are a reminder,
 * because a general service may legitimately cover none of the plan's lines.
 */
export function LifecycleActions({
  id, status, updatedAt, meterReading, meterRequired, hasWorkPerformed, needsServiceSelection, canWork, canApprove, canReturn, correctionHistoryAvailable, locale,
  fixWork, fixMeter,
}: {
  id: string; status: string; updatedAt: string; meterReading: number | null; meterRequired: boolean;
  hasWorkPerformed: boolean; canWork: boolean; canApprove: boolean; locale: Lang;
  canReturn: boolean;
  correctionHistoryAvailable: boolean;
  needsServiceSelection: boolean;
  /** Opens the work dialog, shown beside "write down what was done" when it is missing. */
  fixWork?: ReactNode;
  /** Opens the handover dialog, shown beside the meter item when it is missing. */
  fixMeter?: ReactNode;
}) {
  const [confirm, setConfirm] = useState<null | "complete" | "approve" | "return">(null);
  const [queued, setQueued] = useState(false);
  const [queueError, setQueueError] = useState(false);
  const searchParams = useSearchParams();
  const readyId = useId();
  useEffect(() => { setConfirm(null); }, [status, searchParams]);
  const needsMeter = meterRequired && meterReading == null;
  const canComplete = canWork && status === "in_progress";
  const review = status === "completed";
  const blocked = needsMeter || !hasWorkPerformed;
  const nextStatus = status === "in_progress" ? "waiting_parts" : "in_progress";
  const transitionLabel = status === "waiting_parts" ? "resumeWork" : status === "in_progress" ? "waitForParts" : "startWork";
  const showChecklist = canComplete && (blocked || needsServiceSelection);

  const onCompleteSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    if (isOnline() || !canQueueOffline()) return;
    event.preventDefault();
    try {
      await queueMutation({ type: "complete_job", scope: "app", fields: fieldsFromForm(event.currentTarget) });
      setConfirm(null);
      setQueued(true);
    } catch { setQueueError(true); }
  };

  const item = (done: boolean, label: string, fix?: ReactNode) => (
    <li className="flex min-h-[44px] items-center justify-between gap-3 py-1">
      <span className="flex items-center gap-2.5 text-sm text-sand-900">
        {done ? <CheckIcon className="shrink-0 text-lg text-status-ok" /> : <SquareIcon className="shrink-0 text-lg text-sand-400" />}
        <span className={done ? "text-sand-500 line-through" : undefined}>{label}</span>
      </span>
      {!done && fix ? <span className="shrink-0">{fix}</span> : null}
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      {showChecklist ? (
        <div id={readyId} className="rounded-lg border border-sand-200 px-3 py-2">
          <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-sand-500">{t("jobview.ready.title", locale)}</p>
          <ul className="divide-y divide-sand-100">
            {item(hasWorkPerformed, t("jobview.ready.work", locale), fixWork)}
            {meterRequired ? item(!needsMeter, t("jobview.ready.meter", locale), fixMeter) : null}
            {needsServiceSelection ? item(false, t("jobview.ready.tasks", locale), <a href="#tasks" className="focus-ring inline-flex min-h-[44px] items-center rounded px-2 text-sm font-medium text-brand-ink underline">{t("common.edit", locale)}</a>) : null}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canComplete ? (
          <Button type="button" variant="primary" disabled={blocked || queued} aria-describedby={showChecklist ? readyId : undefined} onClick={() => setConfirm("complete")}>
            {t("jobcards.jobDone", locale)}
          </Button>
        ) : null}
        {review && canApprove ? <Button type="button" variant="primary" onClick={() => setConfirm("approve")}>{t("jobcards.approveLock", locale)}</Button> : null}
        {review && canApprove && canReturn ? <Button type="button" variant="secondary" onClick={() => setConfirm("return")}>{t("jobcards.workflow.returnWork", locale)}</Button> : null}
        {canWork && !review ? (
          <form action={changeJobCardStatus}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="updated_at" value={updatedAt} />
            <input type="hidden" name="status" value={nextStatus} />
            <SubmitButton variant={status === "in_progress" ? "secondary" : "primary"}>{t(`jobcards.workflow.${transitionLabel}`, locale)}</SubmitButton>
          </form>
        ) : null}
      </div>
      {review && canApprove && !canReturn ? (
        <p className="text-sm text-sand-500">{t(correctionHistoryAvailable ? "jobcards.workflow.billedReview" : "jobcards.workflow.historicalReview", locale)}</p>
      ) : null}
      {queued ? <p role="status" className="text-sm text-status-due">{t("offline.savedOffline", locale)}</p> : null}
      {queueError ? <p role="alert" className="text-sm text-status-overdue">{t("jobcards.workflow.queueFailed", locale)}</p> : null}

      <Modal open={confirm === "complete"} onClose={() => setConfirm(null)} title={t("jobcards.confirmComplete", locale)} closeLabel={t("common.cancel", locale)}>
        <p className="text-sm text-sand-600">{t("jobcards.workflow.completeHint", locale)}</p>
        <form action={completeJobCard} onSubmit={onCompleteSubmit} className="mt-4 flex flex-wrap justify-end gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="updated_at" value={updatedAt} />
          <input type="hidden" name="meter_reading" value={meterReading ?? ""} />
          <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>{t("common.cancel", locale)}</Button>
          <SubmitButton variant="primary" disabled={blocked}>{t("jobcards.markCompleted", locale)}</SubmitButton>
        </form>
      </Modal>
      <Modal open={confirm === "approve"} onClose={() => setConfirm(null)} title={t("jobcards.confirmApprove", locale)} closeLabel={t("common.cancel", locale)}>
        <p className="text-sm text-sand-600">{t("jobcards.workflow.approveHint", locale)}</p>
        <form action={approveJobCard} className="mt-4 flex flex-wrap justify-end gap-2">
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
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>{t("common.cancel", locale)}</Button>
            <SubmitButton variant="primary">{t("jobcards.workflow.returnWork", locale)}</SubmitButton>
          </div>
        </form>
      </Modal>
    </div>
  );
}
