"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Who, and over what period.
 *
 * Three plain controls rather than a filter bar: a statement has exactly one customer and
 * one window, and there is nothing to combine. Changing the customer navigates
 * immediately — that is the common move — while the dates wait for "Show", because
 * half-typed dates would otherwise fire a query per keystroke.
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

  return (
    <Card>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr),1fr,1fr,auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          go({ from: String(fd.get("from") ?? from), to: String(fd.get("to") ?? to) });
        }}
      >
        <Field label={t("statement.customer", locale)} htmlFor="party">
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
        <Field label={t("statement.from", locale)} htmlFor="from">
          <Input id="from" name="from" type="date" defaultValue={from} />
        </Field>
        <Field label={t("statement.to", locale)} htmlFor="to">
          <Input id="to" name="to" type="date" defaultValue={to} />
        </Field>
        <Button type="submit" variant="secondary">
          {t("statement.show", locale)}
        </Button>
      </form>
    </Card>
  );
}
