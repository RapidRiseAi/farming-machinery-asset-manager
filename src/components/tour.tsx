"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Overlay } from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icons";
import { t, type Lang } from "@/lib/i18n";
import { TOUR_SEEN_KEY, TOUR_STEP_KEY, type TourStep } from "@/lib/tour";

/**
 * The walkthrough itself: one card at a time, in thumb reach, with a visible way out.
 *
 * Three rules it follows that most product tours break:
 *
 *  - It never traps you. "Skip" is on the first card, not buried at the end, and the
 *    overlay closes on Escape and on a backdrop tap like any other dialog here.
 *  - It survives leaving. Progress is written to localStorage on every step, so
 *    "Show me" can send you to the real screen and the tour picks up where it left off
 *    the next time you land on your home screen.
 *  - It shows up once, on its own, and then only when asked. After it is finished or
 *    skipped it is reachable from the page-info panel — it does not reappear.
 */
export function Tour({
  steps,
  locale,
  homePath,
}: {
  steps: TourStep[];
  locale: Lang;
  /**
   * The role's own home. The tour may open itself HERE and nowhere else — landing
   * mid-task and being interrupted by a tutorial is the thing people hate about them.
   */
  homePath: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const atHome = pathname === homePath;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let done = false;
    let saved = 0;
    try {
      done = window.localStorage.getItem(TOUR_SEEN_KEY) === "1";
      saved = Number(window.localStorage.getItem(TOUR_STEP_KEY) ?? "0");
    } catch {
      // Private mode or storage disabled — treat as "never seen", never crash.
    }
    if (Number.isFinite(saved) && saved > 0 && saved < steps.length) setI(saved);
    if (atHome && !done) setOpen(true);

    // Re-openable from anywhere without prop-drilling a handler through the shell.
    const reopen = () => {
      setI(0);
      setOpen(true);
    };
    window.addEventListener("fleetwise:start-tour", reopen);
    return () => window.removeEventListener("fleetwise:start-tour", reopen);
  }, [atHome, steps.length]);

  function remember(step: number, finished: boolean) {
    try {
      window.localStorage.setItem(TOUR_STEP_KEY, String(step));
      if (finished) window.localStorage.setItem(TOUR_SEEN_KEY, "1");
    } catch {
      /* storage unavailable — the tour still works for this session */
    }
  }

  function close(finished: boolean) {
    remember(finished ? 0 : i, finished);
    setOpen(false);
  }

  if (steps.length === 0) return null;
  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;

  return (
    <Overlay open={open} onClose={() => close(false)} align="responsive" labelledBy="tour-title">
      <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden>
        <span className="h-1.5 w-10 rounded-full bg-sand-300" />
      </div>

      <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-sand-500">
            {t("tour.stepOf", locale).replace("{n}", String(i + 1)).replace("{total}", String(steps.length))}
          </span>
          {/* Out on the first card, not buried at the end. */}
          <button
            type="button"
            onClick={() => close(true)}
            className="focus-ring inline-flex min-h-[48px] items-center rounded-lg px-2 text-sm font-medium text-sand-500 hover:text-sand-800 sm:min-h-[36px]"
          >
            {t("tour.skip", locale)}
          </button>
        </div>

        {/* Progress as a row of bars: how much is left, without a percentage. */}
        <div className="flex gap-1" aria-hidden>
          {steps.map((s, n) => (
            <span
              key={s.id}
              className={`h-1 flex-1 rounded-full ${n <= i ? "bg-brand-600" : "bg-sand-200"}`}
            />
          ))}
        </div>

        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-[1.35rem] text-brand-700">
            <Icon name={step.icon as IconName} />
          </span>
          <div className="min-w-0">
            <h2 id="tour-title" className="text-lg font-bold leading-snug text-sand-950">
              {t(`tour.${step.id}Title`, locale)}
            </h2>
            <p className="mt-1.5 text-[0.95rem] leading-relaxed text-sand-700">
              {t(`tour.${step.id}Body`, locale)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {i > 0 ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const next = i - 1;
                setI(next);
                remember(next, false);
              }}
            >
              {t("tour.back", locale)}
            </Button>
          ) : null}

          {last ? (
            <Button type="button" variant="primary" onClick={() => close(true)} className="flex-1">
              {t("tour.finish", locale)}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              className="flex-1"
              onClick={() => {
                const next = i + 1;
                setI(next);
                remember(next, false);
              }}
            >
              {t("tour.next", locale)}
            </Button>
          )}
        </div>

        {step.href ? (
          // Leaving is a first-class move, not an escape hatch: the tour resumes from
          // the saved step the next time they land on their home screen.
          <Link
            href={step.href}
            onClick={() => remember(Math.min(i + 1, steps.length - 1), false)}
            className={buttonVariants({ variant: "ghost", fullWidth: true })}
          >
            {t("tour.showMe", locale)}
          </Link>
        ) : null}
      </div>
    </Overlay>
  );
}

/** Re-opens the tour from anywhere — used by the help card on the info panel. */
export function StartTourButton({ label }: { label: string }) {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => window.dispatchEvent(new Event("fleetwise:start-tour"))}
    >
      {label}
    </Button>
  );
}
