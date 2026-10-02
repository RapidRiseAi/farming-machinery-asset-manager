"use client";

import { useState } from "react";
import { Overlay } from "./dialog";
import { Button } from "./button";
import { InfoIcon, CheckIcon } from "./icons";
import { cn } from "./cn";

export type PageInfoContent = {
  /** The screen's name, as the person would say it. */
  title: string;
  /** One sentence: what this screen is for. */
  what: string;
  /** What they can actually do here, one plain line each, not feature names. */
  does: string[];
  /** Optional: when this screen matters / who it is for. */
  note?: string;
};

/**
 * "What is this page for?", the same affordance in the same place on every screen.
 *
 * The product assumes a farm office already knows what a job card, a watch item or a
 * work request is. Someone opening FleetWise for the first time, often the person who
 * did not choose it, had no way to ask what a screen was for without leaving it.
 *
 * A quiet button by the page title, not a tour step and not a tooltip: it is there when
 * they want it and invisible when they don't, and it costs nothing to ignore. Render it
 * through `PageHeader`'s `infoKey` so it lands in the same place on every screen.
 */
export function PageInfo({
  content,
  buttonLabel,
  closeLabel,
  tourLabel,
  headingId = "page-info-title",
  triggerClassName,
}: {
  content: PageInfoContent;
  buttonLabel: string;
  closeLabel: string;
  /** Re-entry to the walkthrough. Somewhere findable beats a one-time-only tour. */
  tourLabel?: string;
  headingId?: string;
  /** Placement only (margins); `PageHeader` uses it to sit the trigger in its meta row. */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Quiet, not a button-shaped button: no border and muted ink, so it reads as help
          and never competes with the page's real actions (it used to wear the secondary
          button's border and surface). Icon AND word, never icon-only: this project
          forbids icon-only controls. It stays compact by WHERE it sits instead: in
          `PageHeader` it lives on the line under the title, so it never takes width from
          the h1 on a 360px phone. The 48px hit area stays. */}
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "focus-ring inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-ink-muted hover:bg-sand-100 hover:text-ink sm:min-h-[40px]",
          triggerClassName,
        )}
      >
        <InfoIcon className="text-lg" />
        {buttonLabel}
      </button>

      <Overlay open={open} onClose={() => setOpen(false)} align="responsive" labelledBy={headingId}>
        <div className="flex justify-center pt-2.5 sm:hidden" aria-hidden>
          <span className="h-1.5 w-10 rounded-full bg-sand-300" />
        </div>

        <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
          <h2 id={headingId} className="text-lg font-bold text-sand-950">
            {content.title}
          </h2>
          <p className="text-base leading-relaxed text-sand-700">{content.what}</p>

          <ul className="flex flex-col gap-2">
            {content.does.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm text-sand-700">
                <span className="mt-0.5 shrink-0 text-base text-brand-ink">
                  <CheckIcon />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {content.note ? (
            <p className="rounded-lg bg-sand-50 px-3 py-2.5 text-sm text-sand-600">{content.note}</p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Button type="button" variant="primary" onClick={() => setOpen(false)} fullWidth>
              {closeLabel}
            </Button>
            {tourLabel ? (
              <Button
                type="button"
                variant="ghost"
                fullWidth
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new Event("fleetwise:start-tour"));
                }}
              >
                {tourLabel}
              </Button>
            ) : null}
          </div>
        </div>
      </Overlay>
    </>
  );
}
