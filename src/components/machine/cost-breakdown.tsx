"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { PALETTES, swatchStyle } from "@/lib/dashboard/palettes";
import { BreakdownChart } from "@/components/dashboard/charts";
import { Modal } from "@/components/ui/dialog";
import { cn } from "@/components/ui/cn";
import { ChevronRightIcon } from "@/components/ui/icons";
import type { CSSProperties } from "react";

export type CostPeriod = {
  key: "month" | "year" | "life";
  total: number;
  items: { key: string; label: string; value: number }[];
};

/**
 * The machine's running-cost tile, which opens what the money went on: parts, labour,
 * outside invoices, fuel, finance and the rest, for this month, the last twelve months or
 * its whole life. The figures are the same cost ledger the Costs tab and the reports read.
 */
export function CostBreakdown({
  periods, children, fullHref, title, locale,
}: { periods: CostPeriod[]; children: ReactNode; fullHref: string; title: string; locale: Lang }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<CostPeriod["key"]>("year");
  const period = periods.find((p) => p.key === key) ?? periods[0];
  const items = period.items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring group flex h-full w-full flex-col rounded-2xl border border-sand-200 bg-surface p-4 text-left shadow-card transition hover:border-brand-600/50 hover:shadow-soft"
        aria-haspopup="dialog"
      >
        {children}
        <span className="mt-auto flex items-center gap-1 pt-2 text-sm font-semibold text-brand-ink">
          {t("machine.dash.seeBreakdown", locale)}
          <ChevronRightIcon className="text-base transition group-hover:translate-x-0.5" />
        </span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} closeLabel={t("ui.close", locale)} className="max-w-2xl">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("machine.dash.periodLabel", locale)}>
            {periods.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={p.key === key}
                onClick={() => setKey(p.key)}
                className={cn(
                  "focus-ring inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-semibold transition",
                  p.key === key ? "border-brand-600 bg-brand-600 text-white" : "border-sand-300 bg-surface text-sand-800 hover:bg-surface-hover",
                )}
              >
                {t(`machine.dash.period.${p.key}`, locale)}
              </button>
            ))}
          </div>
          <div className="flex items-baseline justify-between gap-3 border-b border-sand-100 pb-3">
            <span className="text-sm font-semibold text-sand-700">{t("dash.total", locale)}</span>
            <span className="text-3xl font-bold tabular-nums text-sand-950">{rands(period.total)}</span>
          </div>
          {items.length === 0 ? (
            <p className="py-6 text-center text-sand-600">{t("machine.dash.noCosts", locale)}</p>
          ) : (
            <>
              <div className="h-48">
                <BreakdownChart
                  data={{ kind: "breakdown", format: "rands", statusColoured: false, items }}
                  chart="donut"
                  colours="fleetwise"
                  title={title}
                  locale={locale}
                />
              </div>
              <ul className="flex flex-col divide-y divide-sand-100">
                {items.map((i, n) => (
                  <li key={i.key} className="flex items-center gap-3 py-2.5">
                    <span aria-hidden="true" className="viz-c viz-bg size-3 shrink-0 rounded-sm"
                      style={swatchStyle(PALETTES.fleetwise[Math.min(n, PALETTES.fleetwise.length - 1)]) as CSSProperties} />
                    <span className="min-w-0 flex-1 font-medium text-sand-900">{i.label}</span>
                    <span className="w-14 text-right text-sm tabular-nums text-sand-600">
                      {period.total > 0 ? `${Math.round((i.value / period.total) * 100)}%` : ""}
                    </span>
                    <span className="w-32 text-right font-semibold tabular-nums text-sand-950">{rands(i.value)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link href={fullHref} className="focus-ring inline-flex items-center gap-1 self-start rounded-md font-semibold text-brand-ink hover:underline">
            {t("machine.dash.fullCosts", locale)}
            <ChevronRightIcon className="text-base" />
          </Link>
        </div>
      </Modal>
    </>
  );
}
