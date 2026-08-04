"use client";

import { useState, type ReactNode } from "react";
import { t, type Locale, type Lang } from "@/lib/i18n";
import { cn } from "@/components/ui/cn";
import { FaultsIcon, MachinesIcon, FuelIcon, JobCardsIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";

export type QrTask = "fault" | "reading" | "fuel" | "service";

/**
 * The no-login screen. A driver holds a cracked phone next to a broken tractor, in the
 * sun, maybe in Afrikaans, maybe not confident reading either language.
 *
 * The page used to open with FOUR forms expanded at once — report a problem, log a
 * reading, log a service, log fuel — so someone who scanned to report smoke had to
 * scroll past three other forms to reach it. Now: one question, big tiles, and only the
 * chosen form opens.
 *
 * Purely presentational state. Each panel still contains the same server-action form it
 * always did, so the token-gated service-role path and its zero-anon-DB property are
 * untouched.
 */
export function QrChooser({
  locale,
  tiles,
  panels,
}: {
  locale: Lang;
  tiles: { task: QrTask; title: string; hint: string }[];
  panels: Partial<Record<QrTask, ReactNode>>;
}) {
  const [task, setTask] = useState<QrTask | null>(null);

  const ICONS: Record<QrTask, ReactNode> = {
    fault: <FaultsIcon />,
    reading: <MachinesIcon />,
    fuel: <FuelIcon />,
    service: <JobCardsIcon />,
  };

  if (task) {
    const chosen = tiles.find((x) => x.task === task);
    return (
      <section className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => setTask(null)}
          className="focus-ring -ml-1 inline-flex min-h-[48px] w-fit items-center gap-1 rounded-lg px-1 text-base font-medium text-sand-600"
        >
          <ChevronLeftIcon className="text-[1.2rem]" />
          {t("qr.back", locale)}
        </button>
        <h2 className="text-[1.55rem] font-bold leading-tight tracking-tight text-sand-950">
          {chosen?.title}
        </h2>
        <div className="rounded-2xl border border-sand-200 bg-white p-4 shadow-card">
          {panels[task]}
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-[1.55rem] font-bold leading-tight tracking-tight text-sand-950">
        {t("qr.whatDoYouWant", locale)}
      </h2>
      <p className="mt-1 text-sm text-sand-500">{t("qr.noLoginNeeded", locale)}</p>
      <ul className="mt-4 flex flex-col gap-2.5">
        {tiles.map((tile) => (
          <li key={tile.task}>
            <button
              type="button"
              onClick={() => setTask(tile.task)}
              className={cn(
                "focus-ring flex w-full items-center gap-3.5 rounded-2xl border bg-white px-4 py-4 text-left transition-colors",
                tile.task === "fault"
                  ? "border-status-overdue/30 hover:bg-red-50/50"
                  : "border-sand-200 hover:bg-sand-50",
              )}
            >
              <span
                className={cn(
                  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-[1.5rem]",
                  tile.task === "fault" ? "bg-red-50 text-status-overdue" : "bg-brand-50 text-brand-700",
                )}
                aria-hidden
              >
                {ICONS[tile.task]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[1.1rem] font-semibold leading-snug text-sand-900">
                  {tile.title}
                </span>
                <span className="mt-0.5 block text-sm leading-snug text-sand-500">{tile.hint}</span>
              </span>
              <ChevronRightIcon className="shrink-0 text-[1.3rem] text-sand-300" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
