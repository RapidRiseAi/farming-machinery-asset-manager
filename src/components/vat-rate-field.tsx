"use client";

import { useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { percentToBps } from "@/lib/format";

/**
 * VAT asked in percent, stored in basis points.
 *
 * The settings field was `vat_rate_bps` with a default of 1500 — a farmer reads that as
 * fifteen hundred percent, or types 15 and silently sets VAT to 0.15%. The visible input
 * now speaks percent; a hidden field posts the same `vat_rate_bps` name with the same
 * basis-point units, so `updateSettings` is untouched.
 */
export function VatRateField({ defaultBps, locale }: { defaultBps: number; locale: Locale }) {
  const [percent, setPercent] = useState(String(defaultBps / 100));
  const bps = percentToBps(percent);

  return (
    <>
      <input type="hidden" name="vat_rate_bps" value={bps ?? defaultBps} />
      <Field
        label={t("settings.vatRate", locale)}
        htmlFor="vat_rate_percent"
        hint={t("settings.vatRateHint", locale)}
      >
        <div className="relative">
          <Input
            id="vat_rate_percent"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className="pr-9"
          />
          <span
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base font-medium text-sand-500"
            aria-hidden
          >
            %
          </span>
        </div>
      </Field>
    </>
  );
}
