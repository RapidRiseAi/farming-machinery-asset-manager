"use client";

import { useEffect, useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { parseRandsToCents, rands } from "@/lib/money";
import { buildSchedule, percentToBps, scheduleTotals, type ScheduleResult } from "@/lib/asset-finance";
import { errorMessage } from "@/lib/errors";
import { shortDate } from "@/lib/format";

/**
 * What the agreement's terms work out to, while they are typed: the instalment, the
 * interest over the term and the last due date. The SAME function the tests pin to the
 * database's schedule (`buildSchedule` mirrors `app.finance_schedule`), so the figure here
 * is the figure the saved schedule will have, and a set of terms the database would refuse
 * says why before anybody presses Save.
 *
 * It reads its own form (the fields are server-rendered), so it needs no state threaded
 * through the dialog; without JavaScript it is simply absent and the form still saves.
 */
export function SchedulePreview({ locale }: { locale: Lang }) {
  const ref = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<ScheduleResult | null>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const read = () => {
      const value = (name: string) => {
        const el = form.elements.namedItem(name);
        return el && "value" in el ? String((el as unknown as { value: string }).value) : "";
      };
      const principal = parseRandsToCents(value("principal"));
      const term = Number(value("term_months"));
      const first = value("first_instalment_date");
      const rate = percentToBps(value("interest_rate"));
      if (principal == null || !Number.isInteger(term) || term < 1 || !first || rate === false) {
        setResult(null);
        return;
      }
      setResult(buildSchedule({
        principalCents: principal,
        rateBps: rate,
        termMonths: term,
        frequency: value("frequency") || "monthly",
        firstDate: first,
        balloonCents: parseRandsToCents(value("balloon")) ?? 0,
        instalmentCents: parseRandsToCents(value("instalment")),
        feeCents: parseRandsToCents(value("fee")) ?? 0,
      }));
    };
    read();
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => {
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
    };
  }, []);

  const L = (key: string) => t(`assetFinance.${key}`, locale);
  let body: React.ReactNode = <span className="text-sand-500">{L("previewEmpty")}</span>;
  if (result && !result.ok) {
    body = <span className="text-status-overdue">{errorMessage(result.error, locale)}</span>;
  } else if (result && result.ok) {
    const totals = scheduleTotals(result.rows);
    const lastDue = result.rows[result.rows.length - 1]?.dueDate ?? "";
    body = (
      <span className="text-sand-700">
        {L("previewValue")
          .replace("{instalment}", rands(result.paymentCents))
          .replace("{interest}", rands(totals.interestCents + totals.feeCents))
          .replace("{rate}", String(result.rateBps / 100))
          .replace("{last}", lastDue ? shortDate(lastDue, locale) : "")}
      </span>
    );
  }

  return (
    <div ref={ref} className="rounded-lg bg-surface-sunken p-3 text-sm sm:col-span-2" aria-live="polite">
      <p className="text-xs font-medium uppercase tracking-wide text-sand-500">{L("previewTitle")}</p>
      <p className="mt-1">{body}</p>
    </div>
  );
}
