"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { shortDate } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DialogForm, DialogFields, useDialogForm } from "@/components/ui/dialog-form";

/**
 * Who, and over what period.
 *
 * The customer is the one control on the page: changing it navigates at once, because
 * that is the common move. The period is stated as a sentence ("01 Sept 2026 to 30 Sept
 * 2026") with a button that opens the two date boxes in a dialog. They used to sit open
 * beside the customer with a "Show" button, three form controls at rest for a choice
 * most visits never change, and half-typed dates there would have fired a query per
 * keystroke had they applied on change.
 */
export function StatementPicker({
  parties,
  selected,
  from,
  to,
  locale,
}: {
  parties: { key: string; label: string }[];
  selected: string;
  from: string;
  to: string;
  locale: Lang;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function go(next: Record<string, string>) {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) q.set(k, v);
    router.push(`/statements?${q.toString()}`);
  }

  const range = t("books.range", locale)
    .replace("{from}", shortDate(from, locale))
    .replace("{to}", shortDate(to, locale));

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label={t("statement.customer", locale)} htmlFor="party" className="min-w-0 sm:flex-1">
          <Select
            id="party"
            name="party"
            defaultValue={selected}
            onChange={(e) => go({ party: e.target.value })}
          >
            {parties.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:pb-1">
          <p className="min-w-0 text-sm text-sand-600">
            {t("filters.period", locale)}:{" "}
            <span className="font-medium text-sand-900">{range}</span>
          </p>
          <DialogForm
            trigger={t("statement.changeDates", locale)}
            triggerVariant="secondary"
            triggerSize="sm"
            title={t("statement.datesTitle", locale)}
            closeLabel={t("ui.close", locale)}
          >
            <DatesForm from={from} to={to} locale={locale} onApply={(f, tt) => go({ from: f, to: tt })} />
          </DialogForm>
        </div>
      </div>
    </Card>
  );
}

/** Inside the dialog, so it can close it once the dates are applied. */
function DatesForm({
  from,
  to,
  locale,
  onApply,
}: {
  from: string;
  to: string;
  locale: Lang;
  onApply: (from: string, to: string) => void;
}) {
  const { close } = useDialogForm();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        onApply(String(fd.get("from") || from), String(fd.get("to") || to));
        close();
      }}
    >
      <DialogFields>
        <Field label={t("statement.from", locale)} htmlFor="stmt-from">
          <Input id="stmt-from" name="from" type="date" defaultValue={from} required />
        </Field>
        <Field label={t("statement.to", locale)} htmlFor="stmt-to">
          <Input id="stmt-to" name="to" type="date" defaultValue={to} required />
        </Field>
      </DialogFields>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close}>
          {t("common.cancel", locale)}
        </Button>
        <Button type="submit">{t("statement.show", locale)}</Button>
      </div>
    </form>
  );
}
