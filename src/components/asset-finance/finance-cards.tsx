import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { num, shortDate } from "@/lib/format";
import { downloadLabels } from "@/lib/interaction-labels";
import {
  addDays,
  bpsToPercentInput,
  centsToInput,
  contractGrossCents,
  contractPaymentDates,
  contractTone,
  agreementTone,
  lenderKnown,
} from "@/lib/asset-finance";
import type { AgreementRow, ContractRow, FinanceDoc, InstalmentRow, SummaryRow } from "@/lib/asset-finance-read";
import {
  clearFinancePayment,
  deleteContract,
  deleteFinanceAgreement,
  endContract,
  recordFinancePayment,
  recordStatementBalance,
  regenerateFinanceSchedule,
  removeFinanceDocument,
  renewContract,
  settleFinanceAgreement,
  updateContract,
  updateFinanceAgreement,
  updateFinanceInstalment,
  uploadFinanceDocument,
} from "@/app/(app)/finance/actions";

import { Badge } from "@/components/ui/badge";
import { Fact, FactList } from "@/components/ui/facts";
import { Disclosure } from "@/components/ui/disclosure";
import { ActionMenu } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { RequestIdInput } from "@/components/ui/request-id-input";
import { DownloadLink } from "@/components/ui/download-link";
import { CalendarIcon, CashIcon, DocumentsIcon, RepeatIcon, TrashIcon } from "@/components/ui/icons";

import { AgreementFields, ContractFields, type MachineOption } from "./finance-fields";
import {
  agreementKindLabel,
  agreementStatusLabel,
  contractKindLabel,
  contractStatusLabel,
  frequencyLabel,
  instalmentStatusLabel,
} from "./labels";

type Common = {
  locale: Lang;
  /** `/finance` or `/machines/{id}`: where every form here sends the person back. */
  back: string;
  today: string;
  docs: FinanceDoc[];
  /** Shown on the Finance page, where the list mixes machines. */
  machineName?: string | null;
  machineId?: string | null;
};

function DocList({ docs, locale, back }: { docs: FinanceDoc[]; locale: Lang; back: string }) {
  if (docs.length === 0) return null;
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  return (
    <ul className="mt-3 flex flex-col gap-1 border-t border-sand-100 pt-3">
      {docs.map((d, i) => (
        <li key={d.id} className="flex min-h-12 items-center justify-between gap-2">
          <DownloadLink
            href={`/api/finance/document/${d.id}`}
            labels={downloadLabels(locale)}
            className="inline-flex min-h-12 min-w-0 items-center gap-2 text-sm font-medium text-brand-ink underline"
          >
            <DocumentsIcon className="shrink-0" />
            <span className="truncate">
              {L("documentName").replace("{n}", String(docs.length - i)).replace("{date}", shortDate(d.created_at, locale))}
            </span>
          </DownloadLink>
          <ConfirmDialog
            triggerLabel={L("removeDocument")}
            triggerIcon={<TrashIcon />}
            triggerVariant="ghost"
            triggerSize="sm"
            title={L("removeDocumentTitle")}
            intro={L("removeDocumentBody")}
            confirmLabel={L("removeDocument")}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
            action={removeFinanceDocument}
          >
            <input type="hidden" name="document_id" value={d.id} />
            <input type="hidden" name="back" value={back} />
          </ConfirmDialog>
        </li>
      ))}
    </ul>
  );
}

function UploadDialog({
  locale,
  back,
  parentType,
  parentId,
  title,
}: {
  locale: Lang;
  back: string;
  parentType: "finance_agreement" | "asset_contract";
  parentId: string;
  title: string;
}) {
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  return (
    <DialogForm
      triggerLook="menuItem"
      trigger={L("attachDocument")}
      triggerIcon={<DocumentsIcon className="text-base" />}
      title={L("attachDocumentTitle")}
      description={title}
      closeLabel={t("ui.close", locale)}
      size="md"
    >
      <form action={uploadFinanceDocument}>
        <RequestIdInput action="finance:upload-document" />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="parent_type" value={parentType} />
        <input type="hidden" name="parent_id" value={parentId} />
        <DialogFields columns={1}>
          <Field label={L("fieldFile")} htmlFor={`doc-${parentId}`} hint={L("fieldFileHint")} required>
            <Input id={`doc-${parentId}`} name="file" type="file" accept="image/*,application/pdf" required />
          </Field>
        </DialogFields>
        <DialogActions cancelLabel={t("common.cancel", locale)}>
          <SubmitButton variant="primary">{L("attachDocument")}</SubmitButton>
        </DialogActions>
      </form>
    </DialogForm>
  );
}

/**
 * One finance agreement: where it stands, its schedule, and what can be done to it.
 *
 * The dialogs are per AGREEMENT, not per row: a 60-month schedule with three dialogs on
 * every row is 180 dialogs on a phone. "Record a payment" picks the instalment from a list
 * that starts at the next one due, which is the one being paid nine times out of ten.
 */
export function AgreementCard({
  agreement: a,
  instalments,
  summary,
  machines,
  ...common
}: Common & {
  agreement: AgreementRow;
  instalments: InstalmentRow[];
  summary: SummaryRow | undefined;
  machines?: MachineOption[];
}) {
  const { locale, back, today, docs, machineName, machineId } = common;
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const lender = lenderKnown(a.lender) ? a.lender : L("lenderNotRecorded");
  const title = a.agreement_number ? `${lender} · ${a.agreement_number}` : lender;
  const active = a.status === "active";
  const overdue = summary?.overdue_count ?? 0;
  const open = instalments.filter((i) => i.status === "open");
  const paid = instalments.filter((i) => i.status === "paid" || (i.status === "open" && i.paid_cents > 0));
  const nextOpen = open[0];
  const rowLabel = (i: InstalmentRow) =>
    `${i.kind === "balloon" ? L("balloonRow") : L("instalmentRow").replace("{n}", String(i.seq))} · ${shortDate(i.due_date, locale)} · ${rands(i.amount_cents - i.paid_cents)}`;

  const balanceHint = !summary
    ? undefined
    : summary.balance_source === "statement" && a.statement_balance_on
      ? L("balancePerStatement").replace("{date}", shortDate(a.statement_balance_on, locale))
      : summary.balance_source === "schedule"
        ? L("balanceEstimate")
        : undefined;

  return (
    <li className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-sm text-sand-600">
            {agreementKindLabel(a.kind, locale)}
            {machineName && machineId ? (
              <>
                {" · "}
                <Link href={`/machines/${machineId}?tab=costs`} className="font-medium text-brand-ink underline">
                  {machineName}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge tone={agreementTone(a.status, overdue)}>
            {overdue > 0 && active ? L("statusOverdue") : agreementStatusLabel(a.status, locale)}
          </Badge>
          <ActionMenu title={title} label={t("common.actions", locale)} closeLabel={closeLabel}>
            {active && open.length > 0 ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("recordPayment")}
                triggerIcon={<CashIcon className="text-base" />}
                title={L("recordPaymentTitle")}
                description={title}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={recordFinancePayment}>
                  <RequestIdInput action="finance:record-payment" />
                  <input type="hidden" name="back" value={back} />
                  <DialogFields>
                    <div className="sm:col-span-2">
                      <Field label={L("fieldInstalmentRow")} htmlFor={`pay-row-${a.id}`} required>
                        <Select id={`pay-row-${a.id}`} name="instalment_id" required defaultValue={nextOpen?.id}>
                          {open.map((i) => <option key={i.id} value={i.id}>{rowLabel(i)}</option>)}
                        </Select>
                      </Field>
                    </div>
                    <Field label={L("fieldPaidAmount")} htmlFor={`pay-amt-${a.id}`} hint={L("fieldPaidAmountHint")}>
                      <Input id={`pay-amt-${a.id}`} name="amount" inputMode="decimal" />
                    </Field>
                    <Field label={L("fieldPaidOn")} htmlFor={`pay-on-${a.id}`}>
                      <Input id={`pay-on-${a.id}`} name="paid_on" type="date" defaultValue={today} max={today} />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label={L("fieldPaymentReference")} htmlFor={`pay-ref-${a.id}`}>
                        <Input id={`pay-ref-${a.id}`} name="reference" maxLength={80} />
                      </Field>
                    </div>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{L("recordPayment")}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {active ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("editAgreement")}
                title={L("editAgreementTitle")}
                description={title}
                closeLabel={closeLabel}
                size="lg"
              >
                <form action={updateFinanceAgreement}>
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="agreement_id" value={a.id} />
                  <AgreementFields locale={locale} idPrefix={`ea-${a.id}`} agreement={a} machines={undefined} today={today} />
                  <DialogActions cancelLabel={cancelLabel} note={L("editAgreementNote")}>
                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {active ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("statementBalance")}
                title={L("statementBalanceTitle")}
                description={L("statementBalanceBody")}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={recordStatementBalance}>
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="agreement_id" value={a.id} />
                  <DialogFields>
                    <Field label={L("fieldStatementBalance")} htmlFor={`st-bal-${a.id}`}>
                      <Input
                        id={`st-bal-${a.id}`}
                        name="statement_balance"
                        inputMode="decimal"
                        defaultValue={centsToInput(a.statement_balance_cents)}
                      />
                    </Field>
                    <Field label={L("fieldStatementOn")} htmlFor={`st-on-${a.id}`}>
                      <Input id={`st-on-${a.id}`} name="statement_on" type="date" defaultValue={a.statement_balance_on ?? today} />
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel} note={L("statementBalanceNote")}>
                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {active && open.length > 0 ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("correctInstalment")}
                triggerIcon={<CalendarIcon className="text-base" />}
                title={L("correctInstalmentTitle")}
                description={L("correctInstalmentBody")}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={updateFinanceInstalment}>
                  <input type="hidden" name="back" value={back} />
                  <DialogFields>
                    <div className="sm:col-span-2">
                      <Field label={L("fieldInstalmentRow")} htmlFor={`fix-row-${a.id}`} required>
                        <Select id={`fix-row-${a.id}`} name="instalment_id" required defaultValue={nextOpen?.id}>
                          {open.map((i) => <option key={i.id} value={i.id}>{rowLabel(i)}</option>)}
                        </Select>
                      </Field>
                    </div>
                    <Field label={L("fieldNewDueDate")} htmlFor={`fix-due-${a.id}`} required>
                      <Input id={`fix-due-${a.id}`} name="due_date" type="date" required defaultValue={nextOpen?.due_date} />
                    </Field>
                    <Field label={L("fieldNewAmount")} htmlFor={`fix-amt-${a.id}`} required>
                      <Input
                        id={`fix-amt-${a.id}`}
                        name="amount"
                        inputMode="decimal"
                        required
                        defaultValue={centsToInput(nextOpen?.amount_cents)}
                      />
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {paid.length > 0 && a.status !== "cancelled" ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("undoPayment")}
                title={L("undoPaymentTitle")}
                description={title}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={clearFinancePayment}>
                  <input type="hidden" name="back" value={back} />
                  <DialogFields columns={1}>
                    <Field label={L("fieldInstalmentRow")} htmlFor={`undo-row-${a.id}`} required>
                      <Select id={`undo-row-${a.id}`} name="instalment_id" required defaultValue={paid[paid.length - 1]?.id}>
                        {paid.map((i) => (
                          <option key={i.id} value={i.id}>
                            {`${i.kind === "balloon" ? L("balloonRow") : L("instalmentRow").replace("{n}", String(i.seq))} · ${rands(i.paid_cents)}`}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="danger">{L("undoPayment")}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {active ? (
              <ConfirmDialog
                triggerLook="menuItem"
                triggerLabel={L("regenerate")}
                triggerIcon={<RepeatIcon />}
                title={L("regenerateTitle")}
                intro={L("regenerateBody")}
                confirmLabel={L("regenerate")}
                cancelLabel={cancelLabel}
                closeLabel={closeLabel}
                tone="brand"
                action={regenerateFinanceSchedule}
              >
                <input type="hidden" name="agreement_id" value={a.id} />
                <input type="hidden" name="back" value={back} />
              </ConfirmDialog>
            ) : null}
            {active ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("settle")}
                title={L("settleTitle")}
                description={L("settleBody").replace(
                  "{amount}",
                  rands(summary?.outstanding_capital_cents ?? a.principal_cents),
                )}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={settleFinanceAgreement}>
                  <RequestIdInput action="finance:settle" />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="agreement_id" value={a.id} />
                  <DialogFields>
                    <Field label={L("fieldSettledOn")} htmlFor={`settle-on-${a.id}`} required>
                      <Input id={`settle-on-${a.id}`} name="settled_on" type="date" required defaultValue={today} max={today} />
                    </Field>
                    <Field label={L("fieldSettlement")} htmlFor={`settle-amt-${a.id}`} hint={L("fieldSettlementHint")} required>
                      <Input
                        id={`settle-amt-${a.id}`}
                        name="settlement"
                        inputMode="decimal"
                        required
                        defaultValue={centsToInput(summary?.outstanding_capital_cents ?? null)}
                      />
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{L("settle")}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            <UploadDialog locale={locale} back={back} parentType="finance_agreement" parentId={a.id} title={title} />
            <ConfirmDialog
              triggerLook="menuItem"
              triggerLabel={L("removeAgreement")}
              triggerIcon={<TrashIcon />}
              title={L("removeAgreementTitle")}
              intro={L("removeAgreementBody")}
              confirmLabel={L("removeAgreement")}
              cancelLabel={cancelLabel}
              closeLabel={closeLabel}
              action={deleteFinanceAgreement}
            >
              <input type="hidden" name="agreement_id" value={a.id} />
              <input type="hidden" name="back" value={back} />
            </ConfirmDialog>
          </ActionMenu>
        </div>
      </div>

      <FactList className="mt-3">
        {active && summary ? (
          <Fact label={L("balance")} value={<span className="tabular-nums">{rands(summary.balance_cents)}</span>} hint={balanceHint} />
        ) : null}
        {active && summary?.next_due_date ? (
          <Fact
            label={summary.next_kind === "balloon" ? L("nextBalloon") : L("nextInstalment")}
            value={`${shortDate(summary.next_due_date, locale)} · ${rands(summary.next_due_cents ?? 0)}`}
          />
        ) : null}
        {active && overdue > 0 && summary ? (
          <Fact
            label={L("overdue")}
            value={<span className="text-status-overdue">{`${num(overdue, 0)} · ${rands(summary.overdue_cents)}`}</span>}
          />
        ) : null}
        <Fact
          label={L("terms")}
          value={L("termsValue")
            .replace("{rate}", bpsToPercentInput(a.interest_rate_bps))
            .replace("{months}", String(a.term_months))
            .replace("{frequency}", frequencyLabel(a.frequency, locale))}
        />
        {summary ? (
          <Fact label={L("paidSoFar")} value={L("paidSoFarValue").replace("{paid}", String(summary.instalments_paid)).replace("{count}", String(summary.instalments))} />
        ) : null}
        {summary ? <Fact label={L("interestToDate")} value={rands(summary.interest_to_date_cents)} /> : null}
        {a.balloon_cents > 0 ? <Fact label={L("fieldBalloon")} value={rands(a.balloon_cents)} /> : null}
        {a.status === "settled" && a.settled_on ? (
          <Fact
            label={L("settledOn")}
            value={`${shortDate(a.settled_on, locale)}${a.settlement_cents ? ` · ${rands(a.settlement_cents)}` : ""}`}
          />
        ) : null}
        {a.auto_mark_paid ? <Fact label={L("fieldDebitOrder")} value={L("yes")} /> : null}
      </FactList>
      {a.migrated_from_machine ? <p className="mt-2 text-xs text-sand-500">{L("migratedNote")}</p> : null}

      {instalments.length > 0 ? (
        <Disclosure
          variant="inline"
          className="mt-3"
          summary={L("schedule")}
          meta={L("scheduleMeta").replace("{count}", String(instalments.length))}
        >
          <ul className="flex flex-col divide-y divide-sand-100 text-sm">
            {instalments.map((i) => {
              const late = i.status === "open" && i.due_date < today;
              return (
                <li key={i.id} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {i.kind === "balloon" ? L("balloonRow") : L("instalmentRow").replace("{n}", String(i.seq))}
                      {" · "}
                      {shortDate(i.due_date, locale)}
                    </p>
                    <p className="text-xs text-sand-500">
                      {L("rowDetail")
                        .replace("{interest}", rands(i.interest_cents + i.fee_cents))
                        .replace("{capital}", rands(i.capital_cents))
                        .replace("{balance}", rands(i.balance_after_cents))}
                      {i.paid_on ? ` · ${L("paidOnValue").replace("{date}", shortDate(i.paid_on, locale))}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="font-medium tabular-nums text-ink">{rands(i.amount_cents)}</span>
                    <Badge tone={i.status === "paid" ? "ok" : late ? "danger" : i.status === "settled" ? "neutral" : "info"}>
                      {late ? L("statusOverdue") : instalmentStatusLabel(i.status, locale)}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        </Disclosure>
      ) : null}
      <DocList docs={docs} locale={locale} back={back} />
    </li>
  );
}

/** One lease, rental or service contract. */
export function ContractCard({
  contract: c,
  machines,
  fixedMachineId,
  ...common
}: Common & { contract: ContractRow; machines?: MachineOption[]; fixedMachineId?: string }) {
  const { locale, back, today, docs, machineName, machineId } = common;
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const closeLabel = t("ui.close", locale);
  const cancelLabel = t("common.cancel", locale);
  const title = c.reference ? `${c.party} · ${c.reference}` : c.party;
  const active = c.status === "active";
  const anchor = c.first_payment_date ?? c.start_date;
  const horizon = addDays(today, 400);
  const nextPayment = active && c.amount_cents > 0
    ? contractPaymentDates(anchor, c.frequency, today, c.auto_renews || !c.end_date ? horizon : (c.end_date < horizon ? c.end_date : horizon))[0] ?? null
    : null;

  return (
    <li className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-sm text-sand-600">
            {contractKindLabel(c.kind, locale)}
            {" · "}
            {machineName && machineId ? (
              <Link href={`/machines/${machineId}?tab=costs`} className="font-medium text-brand-ink underline">
                {machineName}
              </Link>
            ) : c.machine_id ? null : (
              L("wholeFarm")
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge tone={contractTone(c, today)}>{contractStatusLabel(c.status, locale)}</Badge>
          <ActionMenu title={title} label={t("common.actions", locale)} closeLabel={closeLabel}>
            {c.status !== "cancelled" ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("editContract")}
                title={L("editContractTitle")}
                description={title}
                closeLabel={closeLabel}
                size="lg"
              >
                <form action={updateContract}>
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="contract_id" value={c.id} />
                  <ContractFields
                    locale={locale}
                    idPrefix={`ec-${c.id}`}
                    contract={c}
                    machines={machines}
                    fixedMachineId={fixedMachineId}
                    today={today}
                  />
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {c.status !== "cancelled" ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("renewContract")}
                triggerIcon={<RepeatIcon className="text-base" />}
                title={L("renewContractTitle")}
                description={title}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={renewContract}>
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="contract_id" value={c.id} />
                  <DialogFields>
                    <Field label={L("fieldNewEnd")} htmlFor={`renew-end-${c.id}`} required>
                      <Input id={`renew-end-${c.id}`} name="end_date" type="date" required min={c.end_date ?? c.start_date} />
                    </Field>
                    <Field label={L("fieldNewContractAmount")} htmlFor={`renew-amt-${c.id}`} hint={L("fieldNewContractAmountHint")}>
                      <Input id={`renew-amt-${c.id}`} name="amount" inputMode="decimal" />
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{L("renewContract")}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            {active ? (
              <DialogForm
                triggerLook="menuItem"
                trigger={L("endContract")}
                triggerIcon={<CalendarIcon className="text-base" />}
                title={L("endContractTitle")}
                description={L("endContractBody")}
                closeLabel={closeLabel}
                size="md"
              >
                <form action={endContract}>
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="contract_id" value={c.id} />
                  <DialogFields columns={1}>
                    <Field label={L("fieldEndOn")} htmlFor={`end-on-${c.id}`} required>
                      <Input id={`end-on-${c.id}`} name="end_date" type="date" required defaultValue={today} min={c.start_date} />
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={cancelLabel}>
                    <SubmitButton variant="primary">{L("endContract")}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            ) : null}
            <UploadDialog locale={locale} back={back} parentType="asset_contract" parentId={c.id} title={title} />
            <ConfirmDialog
              triggerLook="menuItem"
              triggerLabel={L("removeContract")}
              triggerIcon={<TrashIcon />}
              title={L("removeContractTitle")}
              intro={L("removeContractBody")}
              confirmLabel={L("removeContract")}
              cancelLabel={cancelLabel}
              closeLabel={closeLabel}
              action={deleteContract}
            >
              <input type="hidden" name="contract_id" value={c.id} />
              <input type="hidden" name="back" value={back} />
            </ConfirmDialog>
          </ActionMenu>
        </div>
      </div>

      <FactList className="mt-3">
        {c.amount_cents > 0 ? (
          <Fact
            label={L("contractAmount")}
            value={<span className="tabular-nums">{`${rands(contractGrossCents(c.amount_cents, c.vat_rate_bps))} · ${frequencyLabel(c.frequency, locale)}`}</span>}
            hint={c.vat_rate_bps > 0 ? L("inclVat") : undefined}
          />
        ) : null}
        <Fact
          label={L("runs")}
          value={c.end_date
            ? L("runsValue").replace("{start}", shortDate(c.start_date, locale)).replace("{end}", shortDate(c.end_date, locale))
            : L("runsOpen").replace("{start}", shortDate(c.start_date, locale))}
        />
        {active && c.notice_date ? <Fact label={L("noticeBy")} value={shortDate(c.notice_date, locale)} /> : null}
        {nextPayment ? <Fact label={L("nextPayment")} value={shortDate(nextPayment, locale)} /> : null}
        {c.auto_renews ? (
          <Fact label={L("fieldAutoRenews")} value={L("renewsEvery").replace("{months}", String(c.renewal_months ?? 0))} />
        ) : null}
        {!c.post_costs ? <Fact label={L("costs")} value={L("costsNotBooked")} /> : null}
      </FactList>
      <DocList docs={docs} locale={locale} back={back} />
    </li>
  );
}
