"use client";

import { useEffect, useRef, useState } from "react";

import { rands } from "@/lib/money";
import { FEATURE_MIN_PLAN, isPlan, planAllows, type Feature } from "@/lib/entitlements";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { CheckIcon } from "@/components/ui/icons";

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
 * reason: the price has to move as somebody chooses a plan and a number of vehicles.
 * Everything else — the form fields, the submit, the validation — is server-rendered and
 * server-checked.
 *
 * The prices are passed IN rather than fetched. An anonymous visitor has no database
 * access at all in this product (the public QR flow is built on that invariant), and the
 * figures shown here are the same ones the catalogue holds: a test reads the migration and
 * asserts the two agree, and suite section (0) asserts them again in SQL. The INVOICE is
 * always priced from the catalogue, never from anything this component sends.
 *
 * ── Why the comparison is DERIVED and not written out ────────────────────────
 * Every tick is `planAllows(plan, feature)` over the keys of `FEATURE_MIN_PLAN` — the very
 * function the layout, the assistant, the machine page and the report schedules call to
 * refuse a feature. A feature that moves between plans moves on this page in the same
 * commit and cannot be advertised on a plan that will not actually unlock it. Only the
 * LABELS come from the dictionary. Selling something the product then refuses is the one
 * mistake a pricing page must not make.
 */
export function PlanPicker({
  options,
  featureLabels,
  coreFeatures,
  labels,
}: {
  options: PlanOption[];
  /** `FEATURE_MIN_PLAN` key → the sentence a farmer would recognise it by. */
  featureLabels: Record<string, string>;
  /** What every plan includes. Ungated core capability, so it is a list, not a map. */
  coreFeatures: string[];
  labels: {
    vehicles: string;
    monthly: string;
    annual: string;
    perMonth: string;
    perYear: string;
    total: string;
    annualNote: string;
    unavailable: string;
    /** Names the plan radio group. It used to be given `total`, so a screen reader
     *  announced the four plans as "You will pay". */
    choosePlan: string;
    /** Names the monthly/yearly pair, which had no group name at all. */
    howOften: string;
    compareTitle: string;
    compareShow: string;
    compareHide: string;
    /** Screen-reader name of the feature column, which has no visible heading. */
    compareFeature: string;
    /** Under the chosen plan's name, so the highlight is a word as well as a colour. */
    compareChosen: string;
    compareYes: string;
    compareNo: string;
    /** Phone only: the matrix scrolls sideways and nothing else says so. */
    compareSwipe: string;
    saveAnnual: string;
    annualPerMonth: string;
    vehiclesHelp: string;
    vehiclesFewer: string;
    vehiclesMore: string;
    totalMonthlyNote: string;
    totalAnnualNote: string;
  };
}) {
  const firstSellable = options.find((o) => o.monthlyCents != null) ?? options[0];
  const [plan, setPlan] = useState(firstSellable.plan);
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");
  const [vehicles, setVehicles] = useState(3);
  const [comparing, setComparing] = useState(false);

  const chosen = options.find((o) => o.plan === plan) ?? firstSellable;
  const unit = period === "annual" ? chosen.annualCents : chosen.monthlyCents;
  // `Number.parseInt("")` is NaN, which is not > 0, so an emptied box reads as zero rather
  // than rendering "R NaN" at somebody who is halfway through retyping a number.
  const count = Number.isFinite(vehicles) && vehicles > 0 ? vehicles : 0;
  const total = unit == null ? null : unit * count;

  /**
   * The comparison's rows: what every plan includes, then each gated feature in the order
   * the map declares them. A core capability is ticked on every plan because it is, by
   * definition, not in `FEATURE_MIN_PLAN` — no gate anywhere refuses it. A gated one is
   * ticked exactly where `planAllows` says yes, and nowhere else.
   */
  const matrix: { key: string; label: string; has: (p: string) => boolean }[] = [
    ...coreFeatures.map((label, i) => ({ key: `core-${i}`, label, has: () => true })),
    ...(Object.keys(FEATURE_MIN_PLAN) as Feature[]).map((f) => ({
      key: f,
      label: featureLabels[f],
      has: (p: string) => isPlan(p) && planAllows(p, f),
    })),
  ];

  const clampVehicles = (n: number) => Math.min(200, Math.max(1, n));

  // On a phone the plans scroll sideways under a fixed feature column, and the plan
  // somebody has chosen can start off-screen. Bring its column in beside the features when
  // the comparison opens, and again whenever the choice changes while it is open.
  const matrixBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!comparing) return;
    const scroller = matrixBox.current?.querySelector("table")?.parentElement;
    const col = matrixBox.current?.querySelector<HTMLElement>("th[data-chosen]");
    const features = matrixBox.current?.querySelector<HTMLElement>("thead th");
    if (!scroller || !col || !features) return;
    scroller.scrollLeft = Math.max(0, col.offsetLeft - features.offsetWidth);
  }, [comparing, chosen.plan]);

  return (
    <div className="space-y-6">
      <input type="hidden" name="plan" value={plan} />
      <input type="hidden" name="billing_period" value={period} />

      {/* Monthly / yearly FIRST, above the plans. It changes every price below it, so a
          visitor who finds it after choosing has to re-read the whole list. */}
      <div className="flex gap-2" role="group" aria-label={labels.howOften}>
        {(["monthly", "annual"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={`min-h-12 flex-1 rounded-lg border px-4 text-sm font-medium sm:min-h-11 ${
              period === p
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-sand-300 bg-surface"
            }`}
          >
            {p === "monthly" ? labels.monthly : labels.annual}
          </button>
        ))}
      </div>

      <fieldset className="space-y-2">
        {/* Was `labels.total` — the group of plans is not the total, and an invisible
            legend is the one label only assistive technology ever reads. */}
        <legend className="sr-only">{labels.choosePlan}</legend>
        {options.map((o) => {
          const price = period === "annual" ? o.annualCents : o.monthlyCents;
          const selected = o.plan === plan;
          // What two months free is actually worth on this plan, per vehicle, per year.
          // "Two months free" is a claim; a number is an argument.
          const saving =
            o.monthlyCents != null && o.annualCents != null
              ? o.monthlyCents * 12 - o.annualCents
              : 0;
          return (
            <label
              key={o.plan}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${
                selected ? "border-brand-500 bg-brand-tint" : "border-edge bg-surface"
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
                {period === "annual" && saving > 0 ? (
                  <span className="mt-1.5 inline-block rounded-md bg-status-ok/10 px-2 py-0.5 text-xs font-semibold text-status-ok">
                    {labels.saveAnnual.replace("{amount}", rands(saving))}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>

      {/* ── What you actually get ────────────────────────────────────────────
          A one-line blurb was the whole argument for spending R89 a vehicle instead of
          R44, which left the most expensive question on the page unanswered. Collapsed by
          default so the form stays short for somebody who has already decided. */}
      <div>
        <button
          type="button"
          onClick={() => setComparing((c) => !c)}
          aria-expanded={comparing}
          className="min-h-12 text-sm font-medium text-brand-ink underline sm:min-h-11"
        >
          {comparing ? labels.compareHide : labels.compareShow}
        </button>

        {/* All four plans side by side. It used to list what the SELECTED plan
            includes, so somebody weighing Professional against Complete could not see
            the two at once. The feature column stays put while the plans scroll
            sideways on a phone; the chosen plan is tinted AND labelled. */}
        {comparing ? (
          <div className="mt-3 rounded-xl border border-sand-200 bg-surface p-4">
            <p className="text-sm font-semibold text-sand-900">{labels.compareTitle}</p>
            <p className="mt-0.5 text-xs text-sand-600 sm:hidden">{labels.compareSwipe}</p>
            <div ref={matrixBox} className="mt-2">
              {/* `relative` makes the table the containing block for the cells'
                  screen-reader text. Without it those absolutely-positioned spans escaped
                  the sideways scroller and widened the whole page on a phone. */}
              <Table className="relative">
                <Thead>
                  <Tr>
                    <Th className="sticky left-0 z-10 bg-surface">
                      <span className="sr-only">{labels.compareFeature}</span>
                    </Th>
                    {options.map((o) => (
                      <Th
                        key={o.plan}
                        data-chosen={o.plan === chosen.plan || undefined}
                        className={`text-center align-bottom ${o.plan === chosen.plan ? "bg-brand-tint" : ""}`}
                      >
                        {/* Plan names in their own case and free to wrap ("Done-For-" /
                            "You"): the uppercase, unbreakable header made every column
                            wide enough that only one fitted beside the features. */}
                        <span className="block whitespace-normal normal-case tracking-normal">
                          {o.label}
                        </span>
                        {o.plan === chosen.plan ? (
                          <span className="mt-0.5 block text-2xs font-medium normal-case tracking-normal text-brand-ink">
                            {labels.compareChosen}
                          </span>
                        ) : null}
                      </Th>
                    ))}
                  </Tr>
                </Thead>
                <Tbody>
                  {matrix.map((row) => (
                    <Tr key={row.key}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 w-32 min-w-32 bg-surface py-2.5 pl-4 pr-3 text-left text-sm font-normal text-sand-800"
                      >
                        {row.label}
                      </th>
                      {options.map((o) => (
                        <Td
                          key={o.plan}
                          className={`text-center ${o.plan === chosen.plan ? "bg-brand-tint" : ""}`}
                        >
                          {row.has(o.plan) ? (
                            <>
                              <CheckIcon aria-hidden className="inline-block text-lg text-status-ok" />
                              <span className="sr-only">{labels.compareYes}</span>
                            </>
                          ) : (
                            <>
                              <span aria-hidden className="text-sand-400">
                                —
                              </span>
                              <span className="sr-only">{labels.compareNo}</span>
                            </>
                          )}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <label htmlFor="vehicles" className="block text-sm font-medium">
          {labels.vehicles}
        </label>
        <p className="mt-0.5 text-sm text-sand-600">{labels.vehiclesHelp}</p>
        {/* A stepper, because this is a phone in a bakkie. Typing into a bare number box
            with a thumb is the slowest control on the page, and it was the one that moved
            the price. The box stays, so forty vehicles is still one entry rather than
            thirty-seven presses. */}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setVehicles((v) => clampVehicles((Number.isFinite(v) ? v : 1) - 1))}
            aria-label={labels.vehiclesFewer}
            className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-sand-300 bg-surface text-xl font-semibold text-sand-800"
          >
            −
          </button>
          <input
            id="vehicles"
            name="vehicles"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={Number.isFinite(vehicles) ? vehicles : ""}
            onChange={(e) => setVehicles(Number.parseInt(e.target.value, 10))}
            onBlur={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setVehicles(Number.isFinite(n) ? clampVehicles(n) : 1);
            }}
            className="min-h-12 w-full rounded-lg border border-sand-300 bg-surface px-3 text-center text-lg font-semibold tabular-nums sm:min-h-11"
          />
          <button
            type="button"
            onClick={() => setVehicles((v) => clampVehicles((Number.isFinite(v) ? v : 0) + 1))}
            aria-label={labels.vehiclesMore}
            className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-sand-300 bg-surface text-xl font-semibold text-sand-800"
          >
            +
          </button>
        </div>
      </div>

      <div className="border-t border-sand-300 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sand-700">{labels.total}</span>
          <span className="text-2xl font-semibold tabular-nums">
            {total == null
              ? labels.unavailable
              : `${rands(total)} ${period === "annual" ? labels.perYear : labels.perMonth}`}
          </span>
        </div>
        {/* What leaves the bank, and when. "R2 670 per year" and "R2 670 now" are
            different promises, and the second one is the one being made. */}
        <p className="mt-1 text-right text-sm text-sand-600">
          {period === "annual" ? labels.totalAnnualNote : labels.totalMonthlyNote}
        </p>
        {period === "annual" && total != null && count > 0 ? (
          <p className="mt-0.5 text-right text-sm text-sand-600">
            {labels.annualPerMonth.replace("{amount}", rands(Math.round(total / 12)))}
          </p>
        ) : null}
        {period === "annual" ? (
          <p className="mt-2 text-sm text-sand-700">{labels.annualNote}</p>
        ) : null}
      </div>
    </div>
  );
}
