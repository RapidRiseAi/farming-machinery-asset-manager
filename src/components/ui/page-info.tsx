"use client";

import { useState } from "react";
import { Overlay } from "./dialog";
import { Button } from "./button";
import { InfoIcon, CheckIcon } from "./icons";

export type PageInfoContent = {
  /** The screen's name, as the person would say it. */
  title: string;
  /** One sentence: what this screen is for. */
  what: string;
  /** What they can actually do here — one plain line each, not feature names. */
  does: string[];
  /** Optional: when this screen matters / who it is for. */
  note?: string;
};

/**
 * "What is this page for?" — the same affordance in the same place on every screen.
 *
 * The product assumes a farm office already knows what a job card, a watch item or a
 * work request is. Someone opening FleetWise for the first time — often the person who
 * did not choose it — had no way to ask what a screen was for without leaving it.
 *
 * A button beside the page title, not a tour step and not a tooltip: it is there when
 * they want it and invisible when they don't, and it costs nothing to ignore.
 */
export function PageInfo({
  content,
  buttonLabel,
  closeLabel,
  headingId = "page-info-title",
}: {
  content: PageInfoContent;
  buttonLabel: string;
  closeLabel: string;
  headingId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex min-h-[48px] shrink-0 items-center gap-1.5 rounded-lg border border-sand-200 bg-white px-3 text-sm font-medium text-sand-600 hover:bg-sand-50 hover:text-sand-900 sm:min-h-[40px]"
      >
        <InfoIcon className="text-[1.1rem]" />
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
          <p className="text-[0.95rem] leading-relaxed text-sand-700">{content.what}</p>

          <ul className="flex flex-col gap-2">
            {content.does.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm text-sand-700">
                <span className="mt-0.5 shrink-0 text-[1.05rem] text-brand-600">
                  <CheckIcon />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {content.note ? (
            <p className="rounded-lg bg-sand-50 px-3 py-2.5 text-sm text-sand-600">{content.note}</p>
          ) : null}

          <Button type="button" variant="primary" onClick={() => setOpen(false)} fullWidth>
            {closeLabel}
          </Button>
        </div>
      </Overlay>
    </>
  );
}
