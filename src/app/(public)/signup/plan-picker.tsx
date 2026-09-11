"use client";

import { useState } from "react";

import { rands } from "@/lib/money";

type PlanOption = {
  plan: string;
  label: string;
  blurb: string;
  /** Per vehicle per month, VAT-inclusive cents. Null = not on sale online. */
  monthlyCents: number | null;
  /** Per vehicle per YEAR, VAT-inclusive cents. Null = not on sale online. */
  annualCents: number | null;
};

/**
 * The only client component on the sign-up page, and it is client-side for exactly one
 * reason: the price has to move as somebody types a number of vehicles. Everything else —
 * the form fields, the submit, the validation — is server-rendered and server-checked.
 *
 * The prices are passed IN rather than fetched. An anonymous visitor has no database
 * access at all in this product (the public QR flow is built on that invariant), and the
 * figures shown here are the same ones the catalogue holds: a test reads the migration and
 * asserts the two agree, and suite section (0) asserts them again in SQL. The INVOICE is
 * always priced from the catalogue, never from anything this component sends.
 */
export function PlanPicker({
  options,
  labels,
}: {
  options: PlanOption[];
  labels: {
    vehicles: string;
    monthly: string;
    annual: string;
    perMonth: string;
    perYear: string;
    total: string;
    annualNote: string;
    unavailable: string;
  };
}) {
  const firstSellable = options.find((o) => o.monthlyCents != null) ?? options[0];
  const [plan, setPlan] = useState(firstSellable.plan);
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");
  const [vehicles, setVehicles] = useState(3);

  const chosen = options.find((o) => o.plan === plan) ?? firstSellable;
  const unit = period === "annual" ? chosen.annualCents : chosen.monthlyCents;
  const count = Number.isFinite(vehicles) && vehicles > 0 ? vehicles : 0;
  const total = unit == null ? null : unit * count;

  return (
    <div className="space-y-6">
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="billing_period" value={period} />

      <fieldset className="space-y-2">
        <legend className="sr-only">{labels.total}</legend>
        {options.map((o) => {
          const price = period === "annual" ? o.annualCents : o.monthlyCents;
          const selected = o.plan === plan;
          return (
            <label
              key={o.plan}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${
                selected ? "border-brand-500 bg-brand-50" : "border-sand-300 bg-surface-1"
              }`}
            >
              <input
                type="radio"
                name="plan_choice"
                className="mt-1 size-5"
                checked={selected}
                onChange={() => setPlan(o.plan)}
                disabled={price == null}
              />
              <span className="flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{o.label}</span>
                  <span className="text-sm font-medium">
                    {price == null
                      ? labels.unavailable
                      : `${rands(price)} ${period === "annual" ? labels.perYear : labels.perMonth}`}
                  </span>
                </span>
                <span className="mt-1 block text-sm text-sand-700">{o.blurb}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex gap-2">
        {(["monthly", "annual"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={`min-h-12 flex-1 rounded-lg border px-4 text-sm font-medium sm:min-h-11 ${
              period === p
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-sand-300 bg-surface-1"
            }`}
          >
            {p === "monthly" ? labels.monthly : labels.annual}
          </button>
        ))}
      </div>
      {period === "annual" ? (
        <p className="text-sm text-sand-700">{labels.annualNote}</p>
      ) : null}

      <div>
        <label htmlFor="vehicles" className="block text-sm font-medium">
          {labels.vehicles}
        </label>
        <input
          id="vehicles"
          name="vehicles"
          type="number"
          inputMode="numeric"
          min={1}
          max={200}
          value={vehicles}
          onChange={(e) => setVehicles(Number.parseInt(e.target.value, 10))}
          className="mt-1 min-h-12 w-full rounded-lg border border-sand-300 bg-surface-1 px-3 sm:min-h-11"
        />
      </div>

      <div className="flex items-baseline justify-between gap-3 border-t border-sand-300 pt-4">
        <span className="text-sand-700">{labels.total}</span>
        <span className="text-2xl font-semibold">
          {total == null
            ? labels.unavailable
            : `${rands(total)} ${period === "annual" ? labels.perYear : labels.perMonth}`}
        </span>
      </div>
    </div>
  );
}
