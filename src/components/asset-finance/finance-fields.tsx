import { t, type Lang } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFields, DialogSection } from "@/components/ui/dialog-form";
import {
  AGREEMENT_FREQUENCIES,
  AGREEMENT_KINDS,
  CONTRACT_FREQUENCIES,
  CONTRACT_KINDS,
  DEFAULT_CONTRACT_LEAD_DAYS,
  DEFAULT_INSTALMENT_LEAD_DAYS,
  bpsToPercentInput,
  centsToInput,
  lenderKnown,
} from "@/lib/asset-finance";
import type { AgreementRow, ContractRow } from "@/lib/asset-finance-read";
import { agreementKindLabel, contractKindLabel, frequencyLabel } from "./labels";

export type MachineOption = { id: string; name: string };

/**
 * The fields of a finance agreement, for the Add and Edit dialogs.
 *
 * What a farmer has in front of them is the lender's paper: the amount financed, the rate,
 * the term and the instalment. Either the rate or the instalment is enough (the other is
 * worked out, `finance_implied_rate_bps`); the rest folds under "More details". Amounts are
 * ex-VAT like every amount here, and the dialog says so once.
 */
export function AgreementFields({
  locale,
  idPrefix,
  agreement,
  machines,
  today,
}: {
  locale: Lang;
  idPrefix: string;
  agreement?: AgreementRow;
  /** The machine picker (farm page). Omitted on a machine page, which posts its own id. */
  machines?: MachineOption[];
  today: string;
}) {
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const a = agreement;
  const isNew = !a;
  const fid = (name: string) => `${idPrefix}-${name}`;
  return (
    <DialogFields>
      {machines ? (
        <div className="sm:col-span-2">
          <Field label={L("fieldMachine")} htmlFor={fid("machine")} required>
            <Select id={fid("machine")} name="machine_id" required defaultValue="">
              <option value="" disabled>{L("chooseMachine")}</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
        </div>
      ) : null}
      <Field label={L("fieldLender")} htmlFor={fid("lender")} required>
        <Input
          id={fid("lender")}
          name="lender"
          required
          maxLength={120}
          defaultValue={a && lenderKnown(a.lender) ? a.lender : ""}
        />
      </Field>
      <Field label={L("fieldAgreementNumber")} htmlFor={fid("number")}>
        <Input id={fid("number")} name="agreement_number" maxLength={80} defaultValue={a?.agreement_number ?? ""} />
      </Field>
      <Field label={L("fieldPrincipal")} htmlFor={fid("principal")} hint={L("fieldPrincipalHint")} required>
        <Input
          id={fid("principal")}
          name="principal"
          inputMode="decimal"
          required
          defaultValue={centsToInput(a?.principal_cents)}
        />
      </Field>
      <Field label={L("fieldRate")} htmlFor={fid("rate")} hint={L("fieldRateHint")}>
        <Input id={fid("rate")} name="interest_rate" inputMode="decimal" defaultValue={bpsToPercentInput(a?.interest_rate_bps)} />
      </Field>
      <Field label={L("fieldTerm")} htmlFor={fid("term")} required>
        <Input id={fid("term")} name="term_months" inputMode="numeric" required defaultValue={a?.term_months ?? ""} />
      </Field>
      <Field label={L("fieldFrequency")} htmlFor={fid("frequency")}>
        <Select id={fid("frequency")} name="frequency" defaultValue={a?.frequency ?? "monthly"}>
          {AGREEMENT_FREQUENCIES.map((f) => <option key={f} value={f}>{frequencyLabel(f, locale)}</option>)}
        </Select>
      </Field>
      <Field label={L("fieldInstalment")} htmlFor={fid("instalment")} hint={L("fieldInstalmentHint")}>
        <Input id={fid("instalment")} name="instalment" inputMode="decimal" defaultValue={centsToInput(a?.instalment_cents)} />
      </Field>
      <Field label={L("fieldBalloon")} htmlFor={fid("balloon")} hint={L("fieldBalloonHint")}>
        <Input id={fid("balloon")} name="balloon" inputMode="decimal" defaultValue={a && a.balloon_cents > 0 ? centsToInput(a.balloon_cents) : ""} />
      </Field>
      <Field label={L("fieldStart")} htmlFor={fid("start")} required>
        <Input id={fid("start")} name="start_date" type="date" required defaultValue={a?.start_date ?? today} />
      </Field>
      <Field label={L("fieldFirstInstalment")} htmlFor={fid("first")} required>
        <Input id={fid("first")} name="first_instalment_date" type="date" required defaultValue={a?.first_instalment_date ?? ""} />
      </Field>
      {isNew ? (
        <div className="sm:col-span-2">
          <Checkbox
            id={fid("already-paid")}
            name="already_paid"
            label={L("fieldAlreadyPaid")}
            hint={L("fieldAlreadyPaidHint")}
          />
          <Field label={L("fieldPaidBefore")} htmlFor={fid("paid-before")}>
            <Input id={fid("paid-before")} name="paid_before" type="date" defaultValue={today} />
          </Field>
        </div>
      ) : null}
      <DialogSection
        title={L("moreDetails")}
        defaultOpen={!isNew && Boolean(a && (a.deposit_cents > 0 || a.fee_cents > 0 || a.notes || a.kind !== "instalment_sale"))}
      >
        <Field label={L("fieldKind")} htmlFor={fid("kind")}>
          <Select id={fid("kind")} name="kind" defaultValue={a?.kind ?? "instalment_sale"}>
            {AGREEMENT_KINDS.map((k) => <option key={k} value={k}>{agreementKindLabel(k, locale)}</option>)}
          </Select>
        </Field>
        <Field label={L("fieldDeposit")} htmlFor={fid("deposit")} hint={L("fieldDepositHint")}>
          <Input id={fid("deposit")} name="deposit" inputMode="decimal" defaultValue={a && a.deposit_cents > 0 ? centsToInput(a.deposit_cents) : ""} />
        </Field>
        <Field label={L("fieldFee")} htmlFor={fid("fee")} hint={L("fieldFeeHint")}>
          <Input id={fid("fee")} name="fee" inputMode="decimal" defaultValue={a && a.fee_cents > 0 ? centsToInput(a.fee_cents) : ""} />
        </Field>
        <Field label={L("fieldLead")} htmlFor={fid("lead")}>
          <Input
            id={fid("lead")}
            name="reminder_lead_days"
            inputMode="numeric"
            defaultValue={a?.reminder_lead_days ?? DEFAULT_INSTALMENT_LEAD_DAYS}
          />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox
            id={fid("reminders")}
            name="reminders"
            defaultChecked={a ? a.reminder_lead_days != null : true}
            label={L("fieldReminders")}
            hint={L("fieldRemindersHint")}
          />
          <Checkbox
            id={fid("debit")}
            name="auto_mark_paid"
            defaultChecked={a?.auto_mark_paid ?? false}
            label={L("fieldDebitOrder")}
            hint={L("fieldDebitOrderHint")}
          />
        </div>
        <div className="sm:col-span-2">
          <Field label={L("fieldNotes")} htmlFor={fid("notes")}>
            <Textarea id={fid("notes")} name="notes" rows={2} maxLength={2000} defaultValue={a?.notes ?? ""} />
          </Field>
        </div>
      </DialogSection>
    </DialogFields>
  );
}

/**
 * The fields of a lease, rental or service contract. `machines` offers the choice of one
 * machine or the whole farm; a machine page passes `fixedMachineId` instead.
 */
export function ContractFields({
  locale,
  idPrefix,
  contract,
  machines,
  fixedMachineId,
  today,
}: {
  locale: Lang;
  idPrefix: string;
  contract?: ContractRow;
  machines?: MachineOption[];
  fixedMachineId?: string;
  today: string;
}) {
  const L = (key: string) => t(`assetFinance.${key}`, locale);
  const c = contract;
  const isNew = !c;
  const fid = (name: string) => `${idPrefix}-${name}`;
  return (
    <DialogFields>
      {fixedMachineId ? (
        <input type="hidden" name="machine_id" value={fixedMachineId} />
      ) : machines ? (
        <div className="sm:col-span-2">
          <Field label={L("fieldCovers")} htmlFor={fid("machine")} hint={L("fieldCoversHint")}>
            <Select id={fid("machine")} name="machine_id" defaultValue={c?.machine_id ?? ""}>
              <option value="">{L("wholeFarm")}</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
        </div>
      ) : null}
      <Field label={L("fieldContractKind")} htmlFor={fid("kind")}>
        <Select id={fid("kind")} name="kind" defaultValue={c?.kind ?? "operating_lease"}>
          {CONTRACT_KINDS.map((k) => <option key={k} value={k}>{contractKindLabel(k, locale)}</option>)}
        </Select>
      </Field>
      <Field label={L("fieldParty")} htmlFor={fid("party")} required>
        <Input id={fid("party")} name="party" required maxLength={120} defaultValue={c?.party ?? ""} />
      </Field>
      <Field label={L("fieldAmount")} htmlFor={fid("amount")} hint={L("fieldAmountHint")}>
        <Input id={fid("amount")} name="amount" inputMode="decimal" defaultValue={centsToInput(c?.amount_cents)} />
      </Field>
      <Field label={L("fieldFrequency")} htmlFor={fid("frequency")}>
        <Select id={fid("frequency")} name="frequency" defaultValue={c?.frequency ?? "monthly"}>
          {CONTRACT_FREQUENCIES.map((f) => <option key={f} value={f}>{frequencyLabel(f, locale)}</option>)}
        </Select>
      </Field>
      <Field label={L("fieldStart")} htmlFor={fid("start")} required>
        <Input id={fid("start")} name="start_date" type="date" required defaultValue={c?.start_date ?? today} />
      </Field>
      <Field label={L("fieldEnd")} htmlFor={fid("end")} hint={L("fieldEndHint")}>
        <Input id={fid("end")} name="end_date" type="date" defaultValue={c?.end_date ?? ""} />
      </Field>
      <Field label={L("fieldNoticeDays")} htmlFor={fid("notice")} hint={L("fieldNoticeDaysHint")}>
        <Input id={fid("notice")} name="notice_days" inputMode="numeric" defaultValue={c?.notice_days ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        <Checkbox id={fid("vat")} name="vat_charged" defaultChecked={c ? c.vat_rate_bps > 0 : false} label={L("fieldVatCharged")} />
      </div>
      <DialogSection
        title={L("moreDetails")}
        defaultOpen={!isNew && Boolean(c && (c.auto_renews || c.reference || c.notes || c.first_payment_date || !c.post_costs))}
      >
        <Field label={L("fieldReference")} htmlFor={fid("reference")}>
          <Input id={fid("reference")} name="reference" maxLength={80} defaultValue={c?.reference ?? ""} />
        </Field>
        <Field label={L("fieldFirstPayment")} htmlFor={fid("first")} hint={L("fieldFirstPaymentHint")}>
          <Input id={fid("first")} name="first_payment_date" type="date" defaultValue={c?.first_payment_date ?? ""} />
        </Field>
        <Field label={L("fieldRenewalMonths")} htmlFor={fid("renewal")} hint={L("fieldRenewalMonthsHint")}>
          <Input id={fid("renewal")} name="renewal_months" inputMode="numeric" defaultValue={c?.renewal_months ?? ""} />
        </Field>
        <Field label={L("fieldLead")} htmlFor={fid("lead")}>
          <Input
            id={fid("lead")}
            name="reminder_lead_days"
            inputMode="numeric"
            defaultValue={c?.reminder_lead_days ?? DEFAULT_CONTRACT_LEAD_DAYS}
          />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox id={fid("auto")} name="auto_renews" defaultChecked={c?.auto_renews ?? false} label={L("fieldAutoRenews")} hint={L("fieldAutoRenewsHint")} />
          <Checkbox
            id={fid("reminders")}
            name="reminders"
            defaultChecked={c ? c.reminder_lead_days != null : true}
            label={L("fieldContractReminders")}
            hint={L("fieldContractRemindersHint")}
          />
          <Checkbox
            id={fid("post")}
            name="post_costs"
            defaultChecked={c ? c.post_costs : true}
            label={L("fieldPostCosts")}
            hint={L("fieldPostCostsHint")}
          />
        </div>
        <div className="sm:col-span-2">
          <Field label={L("fieldNotes")} htmlFor={fid("notes")}>
            <Textarea id={fid("notes")} name="notes" rows={2} maxLength={2000} defaultValue={c?.notes ?? ""} />
          </Field>
        </div>
      </DialogSection>
    </DialogFields>
  );
}
