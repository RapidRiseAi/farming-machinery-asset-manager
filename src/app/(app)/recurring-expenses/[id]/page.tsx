import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProfile, currentWorkshop } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate, vatPercent } from "@/lib/format";
import { EXPENSE_CATEGORIES, type Expense } from "@/lib/expenses";
import {
  CADENCES,
  advanceByCadence,
  isLive,
  scheduleTotalCents,
  annualisedExCents,
  SCHEDULE_ERROR_KEYS,
  type ExpenseSchedule,
} from "@/lib/recurring-expenses";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { TextField, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TrashIcon } from "@/components/ui/icons";
import {
  updateExpenseSchedule,
  toggleExpenseSchedule,
  runExpenseScheduleNow,
  deleteExpenseSchedule,
} from "../actions";

export const dynamic = "force-dynamic";

/** One standing cost: what it pays, who it pays, and when it next goes out. */
export default async function ExpenseSchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await requireProfile();
  if (profile.role !== "workshop") redirect("/expenses");
  const locale = profile.lang;
  const { id } = await params;
  const sp = await searchParams;

  const { workshop } = await currentWorkshop(profile);
  if (!workshop) redirect("/contractor?error=no-workshop");

  const supabase = await createClient();
  const { data } = await supabase
    .from("recurring_expenses")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const schedule = data as ExpenseSchedule | null;
  if (!schedule) notFound();

  // What this schedule has actually produced. The proof that it is working, and the first
  // place to look when a partner thinks it is not. Only the most recent one is recorded
  // (`last_expense_id`) — the generated rows are ordinary expenses with no back-pointer,
  // deliberately, so nothing downstream has to know this feature exists.
  const { data: lastData } = schedule.last_expense_id
    ? await supabase
        .from("partner_expenses")
        .select("id, supplier_name, expense_date, paid_on, amount_cents, vat_cents")
        .eq("id", schedule.last_expense_id)
        .is("deleted_at", null)
        .maybeSingle()
    : { data: null };
  const last = lastData as Pick<Expense, "id" | "supplier_name" | "expense_date" | "paid_on" | "amount_cents" | "vat_cents"> | null;

  const live = isLive(schedule);
  const totalCents = scheduleTotalCents(schedule);
  const errorKey = sp.error ? SCHEDULE_ERROR_KEYS[sp.error] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Link href="/recurring-expenses" className="focus-ring rounded text-sm text-brand-700 hover:underline">
        ← {t("recexp.title", locale)}
      </Link>

      <Flash tone="error" message={errorKey ? t(errorKey, locale) : sp.error} />
      <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
      <Flash tone="success" message={sp.captured ? t("recexp.capturedFlash", locale) : undefined} />
      <Flash tone="info" message={sp.nothing ? t("recexp.nothingFlash", locale) : undefined} />

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold tracking-tight text-sand-900">{schedule.name}</h1>
        <Badge tone="neutral">{t(`cadence.${schedule.cadence}`, locale)}</Badge>
        <Badge tone="neutral">{t(`expenseCategory.${schedule.category}`, locale)}</Badge>
        {schedule.auto_paid ? <Badge tone="info">{t("recexp.autoPaidBadge", locale)}</Badge> : null}
        {!live ? <Badge tone="warning">{t("recexp.pausedBadge", locale)}</Badge> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("recexp.whatItCosts", locale)}</CardTitle>
        </CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          {schedule.supplier_name}
          {schedule.reference ? ` · ${schedule.reference}` : ""}
        </p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:max-w-sm">
          <dt className="text-sand-600">{t("recexp.exVat", locale)}</dt>
          <dd className="text-right tabular-nums text-sand-900">{rands(schedule.amount_cents)}</dd>
          <dt className="text-sand-600">
            {t("recexp.vat", locale)} ({vatPercent(schedule.vat_rate_bps)})
          </dt>
          <dd className="text-right tabular-nums text-sand-900">{rands(schedule.vat_cents)}</dd>
          <dt className="border-t border-sand-200 pt-1 font-medium text-sand-800">{t("recexp.eachTime", locale)}</dt>
          <dd className="border-t border-sand-200 pt-1 text-right font-semibold tabular-nums text-sand-900">
            {rands(totalCents)}
          </dd>
          {/* The same commitment read the other way round. R4 500 a month is easy to leave
              alone; R54 000 a year is what makes somebody check it is still the right
              amount. */}
          <dt className="text-sand-600">{t("recexp.aYear", locale)}</dt>
          <dd className="text-right tabular-nums text-sand-700">{rands(annualisedExCents(schedule))}</dd>
        </dl>
        {!schedule.vat_claimable ? (
          <p className="mt-3 text-sm text-status-warn">{t("recexp.notClaimableNote", locale)}</p>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("recexp.whenTitle", locale)}</CardTitle>
        </CardHeader>
        <p className="mb-3 text-sm text-sand-600">
          {live
            ? `${t("recexp.nextOn", locale)} ${shortDate(schedule.next_due_date, locale)} · ${t("recexp.thenPreview", locale)} ${advanceByCadence(schedule.next_due_date, schedule.cadence)}`
            : t("recexp.stopped", locale)}
        </p>

        <form action={updateExpenseSchedule} className="flex flex-col gap-3">
          <input type="hidden" name="schedule_id" value={schedule.id} />

          <TextField name="name" label={t("recexp.name", locale)} defaultValue={schedule.name} required />

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              name="supplier_name"
              label={t("recexp.supplier", locale)}
              hint={t("recexp.supplierHint", locale)}
              defaultValue={schedule.supplier_name}
              required
            />
            <TextField name="reference" label={t("recexp.reference", locale)} defaultValue={schedule.reference ?? ""} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField name="category" label={t("recexp.category", locale)} defaultValue={schedule.category}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`expenseCategory.${c}`, locale)}
                </option>
              ))}
            </SelectField>
            {/* Ex-VAT here, not inclusive: the amount already stored IS ex-VAT, and
                pre-filling an inclusive field from it would either restate the figure or
                need the box to change meaning between add and edit. The VAT amount stays
                editable beside it. */}
            <TextField
              name="amount"
              inputMode="decimal"
              label={t("recexp.amountExVat", locale)}
              defaultValue={String(schedule.amount_cents / 100)}
              required
            />
            <TextField
              name="vat_amount"
              inputMode="decimal"
              label={t("recexp.vatAmount", locale)}
              hint={t("recexp.vatAmountHint", locale)}
              defaultValue={String(schedule.vat_cents / 100)}
            />
          </div>
          <input type="hidden" name="vat_percent" value={String(schedule.vat_rate_bps / 100)} />

          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField name="cadence" label={t("recexp.howOften", locale)} defaultValue={schedule.cadence}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {t(`cadence.${c}`, locale)}
                </option>
              ))}
            </SelectField>
            <TextField
              name="next_due_date"
              type="date"
              label={t("recexp.nextDue", locale)}
              defaultValue={schedule.next_due_date}
            />
            <TextField
              name="ends_on"
              type="date"
              label={t("recexp.endsOn", locale)}
              hint={t("recexp.endsOnHint", locale)}
              defaultValue={schedule.ends_on ?? ""}
            />
          </div>

          <TextField name="description" label={t("recexp.description", locale)} defaultValue={schedule.description ?? ""} />
          <TextField
            name="supplier_vat_number"
            label={t("recexp.supplierVat", locale)}
            hint={t("recexp.supplierVatHint", locale)}
            defaultValue={schedule.supplier_vat_number ?? ""}
          />

          <label className="flex items-start gap-3 text-sm text-sand-700">
            <input
              type="checkbox"
              name="vat_claimable"
              defaultChecked={schedule.vat_claimable}
              className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
            />
            <span>
              {t("recexp.claimable", locale)}
              <span className="block text-xs text-sand-500">{t("recexp.claimableHint", locale)}</span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm text-sand-700">
            <input
              type="checkbox"
              name="auto_paid"
              defaultChecked={schedule.auto_paid}
              className="mt-0.5 h-5 w-5 rounded border-sand-300 text-brand-600"
            />
            <span>
              {t("recexp.autoPaid", locale)}
              <span className="block text-xs text-sand-500">{t("recexp.autoPaidHint", locale)}</span>
            </span>
          </label>

          <SubmitButton variant="secondary" className="self-start">
            {t("common.save", locale)}
          </SubmitButton>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("recexp.controlsTitle", locale)}</CardTitle>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmDialog
            action={runExpenseScheduleNow}
            triggerLabel={t("recexp.captureNow", locale)}
            triggerVariant="primary"
            triggerSize="sm"
            tone="brand"
            title={t("recexp.captureNowTitle", locale)}
            intro={t("recexp.captureNowBody", locale)}
            facts={[
              { label: t("recexp.eachTime", locale), value: rands(totalCents) },
              { label: t("recexp.supplier", locale), value: schedule.supplier_name },
            ]}
            consequences={[
              schedule.auto_paid ? t("recexp.captureNowPaid", locale) : t("recexp.captureNowOwing", locale),
              t("recexp.captureNowIdempotent", locale),
            ]}
            confirmLabel={t("recexp.captureNow", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="schedule_id" value={schedule.id} />
          </ConfirmDialog>

          <form action={toggleExpenseSchedule}>
            <input type="hidden" name="schedule_id" value={schedule.id} />
            <input type="hidden" name="active" value={schedule.active ? "0" : "1"} />
            <SubmitButton variant="secondary" size="sm">
              {schedule.active ? t("recexp.pause", locale) : t("recexp.resume", locale)}
            </SubmitButton>
          </form>

          <ConfirmDialog
            action={deleteExpenseSchedule}
            triggerLabel={t("common.remove", locale)}
            triggerIcon={<TrashIcon />}
            triggerVariant="ghost"
            triggerSize="sm"
            title={t("recexp.deleteTitle", locale)}
            intro={schedule.name}
            consequences={[t("recexp.deleteConsequence", locale), t("recexp.deleteKeepsHistory", locale)]}
            confirmLabel={t("common.remove", locale)}
            cancelLabel={t("common.cancel", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <input type="hidden" name="schedule_id" value={schedule.id} />
          </ConfirmDialog>
        </div>
      </Card>

      {last ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("recexp.capturedTitle", locale)}</CardTitle>
          </CardHeader>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-sand-900">{last.supplier_name}</span>
            <span className="text-sand-500">{shortDate(last.expense_date, locale)}</span>
            <Badge tone={last.paid_on ? "ok" : "warning"}>
              {last.paid_on ? t("recexp.paid", locale) : t("recexp.owing", locale)}
            </Badge>
            <span className="ml-auto tabular-nums text-sand-900">{rands(last.amount_cents + last.vat_cents)}</span>
          </div>
          <p className="mt-2 text-sm">
            <Link href="/expenses" className="focus-ring rounded text-brand-700 underline-offset-2 hover:underline">
              {t("recexp.viewInExpenses", locale)} →
            </Link>
          </p>
        </Card>
      ) : null}
    </div>
  );
}
