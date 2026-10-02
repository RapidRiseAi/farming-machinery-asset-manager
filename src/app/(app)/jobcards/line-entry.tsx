"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { t, type Lang } from "@/lib/i18n";
import { rands, parseRandsToCents, exVatCents } from "@/lib/money";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { canQueueOffline, fieldsFromForm, isOnline, queueMutation } from "@/lib/offline/capture";
import { addLine, editJobLine } from "./actions";
import { CheckIcon } from "@/components/ui/icons";
import { DialogActions } from "@/components/ui/dialog-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export type CataloguePart = {
  id: string;
  part_no: string;
  description: string | null;
  typical_cost_cents: number | null;
};
export type EditableJobLine = { id: string; updated_at: string; kind: string; description: string | null; part_no: string | null; qty: number | null; hours: number | null; unit_cost_cents: number | null; rate_cents: number | null };

export function LineEntry({
  jobCardId,
  farmId,
  vatRateBps,
  locale,
  catalogue = [],
  costsVisible = true,
  actorId,
  line,
}: {
  jobCardId: string;
  farmId: string;
  vatRateBps: number;
  locale: Lang;
  catalogue?: CataloguePart[];
  costsVisible?: boolean;
  actorId: string;
  line?: EditableJobLine;
}) {
  const [kind, setKind] = useState<"part" | "labour" | "other">(line?.kind as "part" | "labour" | "other" ?? "part");
  const [inclVat, setInclVat] = useState(false);
  const [qty, setQty] = useState(String(line?.qty ?? 1));
  const [unit, setUnit] = useState(line?.unit_cost_cents != null ? (line.unit_cost_cents / 100).toFixed(2) : "");
  const [partNo, setPartNo] = useState(line?.part_no ?? "");
  const [desc, setDesc] = useState(line?.description ?? "");
  const [hours, setHours] = useState(line?.hours != null ? String(line.hours) : "");
  const [rate, setRate] = useState(line?.rate_cents != null ? (line.rate_cents / 100).toFixed(2) : "");
  const [queued, setQueued] = useState(false);
  const [queueError, setQueueError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draftToken, setDraftToken] = useState("");
  const [draftConflict, setDraftConflict] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const draftKey = `fleetwise:job-line-draft:${actorId}:${jobCardId}${line ? `:${line.id}` : ""}`;
  const successToken = useSearchParams().get("line_token");

  useEffect(() => {
    let token = crypto.randomUUID();
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (typeof saved.token === "string" && saved.token === successToken) {
          // Only this form's acknowledged save clears its draft. Other people's
          // additions and refreshes leave these entries intact.
          localStorage.removeItem(draftKey);
          if (!line) { setKind("part"); setInclVat(false); setQty("1"); setUnit(""); setPartNo(""); setDesc(""); setHours(""); setRate(""); }
        } else {
          setDraftConflict(!!line && saved.version !== line.updated_at);
          setHasDraft(true);
          if (typeof saved.token === "string") token = saved.token;
          if (["part", "labour", "other"].includes(saved.kind)) setKind(saved.kind);
          setInclVat(!!saved.inclVat);
          for (const [field, setter] of [["qty", setQty], ["unit", setUnit], ["partNo", setPartNo], ["desc", setDesc], ["hours", setHours], ["rate", setRate]] as const) {
            if (typeof saved[field] === "string") setter(saved[field]);
          }
        }
      }
    } catch { /* Device storage may be unavailable. */ }
    setDraftToken(token);
    setLoaded(true);
  }, [draftKey, successToken, line]);

  useEffect(() => {
    if (!loaded || draftConflict) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ token: draftToken, version: line?.updated_at, kind, inclVat, qty, unit, partNo, desc, hours, rate })); }
    catch { /* The form can still save online. */ }
  }, [loaded, draftConflict, line?.updated_at, draftKey, draftToken, kind, inclVat, qty, unit, partNo, desc, hours, rate]);

  const discardDraft = () => {
    setKind(line?.kind as typeof kind ?? "part"); setInclVat(false); setQty(String(line?.qty ?? 1));
    setUnit(line?.unit_cost_cents != null ? (line.unit_cost_cents / 100).toFixed(2) : "");
    setPartNo(line?.part_no ?? ""); setDesc(line?.description ?? "");
    setHours(line?.hours != null ? String(line.hours) : "");
    setRate(line?.rate_cents != null ? (line.rate_cents / 100).toFixed(2) : "");
    setDraftToken(crypto.randomUUID()); setDraftConflict(false); setHasDraft(false);
    try { localStorage.removeItem(draftKey); } catch { /* Optional device storage. */ }
  };

  // "Add from catalogue" (F9): pick a catalogue part → prefill part_no/description/cost.
  // Catalogue costs are stored ex-VAT, so we prefill ex-VAT and clear the incl-VAT flag.
  const onPickCatalogue = (id: string) => {
    const p = catalogue.find((c) => c.id === id);
    if (!p) return;
    setPartNo(p.part_no);
    setDesc(p.description ?? "");
    if (costsVisible) setUnit(p.typical_cost_cents != null ? (p.typical_cost_cents / 100).toFixed(2) : "");
    setInclVat(false);
    if (!qty) setQty("1");
  };

  // Offline: queue the line locally (idempotency UUID + client ts) instead of failing.
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    if (isOnline() || !canQueueOffline()) return; // online → native server action
    e.preventDefault();
    if (line) { setQueueError(true); return; }
    const form = e.currentTarget;
    try {
      await queueMutation({ type: "add_job_line", scope: "app", fields: fieldsFromForm(form) });
      setQty("1"); setUnit(""); setHours(""); setRate(""); setPartNo(""); setDesc("");
      setDraftToken(crypto.randomUUID());
      setQueued(true);
    } catch { setQueueError(true); }
  };

  // Live preview of what will be stored (the DB trigger computes the canonical total).
  const baseCents = parseRandsToCents(kind === "labour" ? rate : unit) ?? 0;
  const mult = kind === "part" ? Number(qty) || 0 : kind === "labour" ? Number(hours) || 0 : 1;
  const enteredTotal = Math.round(baseCents * (mult || (kind === "other" ? 1 : 0)));
  const exUnit = inclVat ? exVatCents(baseCents, vatRateBps) : baseCents;
  const exTotal = Math.round(exUnit * (mult || (kind === "other" ? 1 : 0)));
  const vatTotal = enteredTotal - exTotal;
  const showPreview = baseCents > 0;

  return (
    <form action={line ? editJobLine : addLine} onSubmit={onSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="job_card_id" value={jobCardId} />
      <input type="hidden" name="farm_id" value={farmId} />
      <input type="hidden" name="draft_token" value={draftToken} />
      {line ? <><input type="hidden" name="line_id" value={line.id} /><input type="hidden" name="line_updated_at" value={line.updated_at} /><input type="hidden" name="kind" value={line.kind} /></> : null}
      {draftConflict ? <div role="status" className="rounded-lg border border-sand-200 p-3"><p className="text-sm text-sand-600">{t("jobcards.workflow.draftConflict", locale)}</p><div className="mt-2 flex gap-2"><Button type="button" variant="secondary" size="sm" onClick={() => setDraftConflict(false)}>{t("jobcards.workflow.useDraft", locale)}</Button><Button type="button" variant="ghost" size="sm" onClick={discardDraft}>{t("jobcards.workflow.keepSaved", locale)}</Button></div></div> : null}

      {/* Part, labour or other is the first decision and there are only three, so they
          are a segmented choice rather than a dropdown. An existing line keeps its kind. */}
      {line ? (
        <p className="text-sm text-sand-600">{t("jobcards.kind", locale)}: <span className="font-medium text-sand-900">{t(`jobcards.${kind}Kind`, locale)}</span></p>
      ) : (
        <fieldset className="min-w-0">
          <legend className="sr-only">{t("jobcards.kind", locale)}</legend>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-sand-100 p-1">
            {(["part", "labour", "other"] as const).map((k) => (
              <label key={k} className={`focus-within:ring-2 focus-within:ring-brand-500/40 flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors ${kind === k ? "bg-surface text-sand-900 shadow-xs" : "text-sand-600 hover:text-sand-900"}`}>
                <input type="radio" className="sr-only" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
                {t(`jobcards.${k}Kind`, locale)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Field label={t("jobcards.description", locale)} htmlFor="line-desc">
        <Input id="line-desc" name="description" required={kind !== "part" || !partNo.trim()} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>

      {kind === "part" ? (
        <>
          {catalogue.length > 0 ? (
            <Field label={t("jobcards.fromCatalogue", locale)} htmlFor="line-catalogue">
              <Select id="line-catalogue" defaultValue="" onChange={(e) => onPickCatalogue(e.target.value)}>
                <option value="">{t("jobcards.cataloguePick", locale)}</option>
                {catalogue.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.part_no}{c.description ? `, ${c.description}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label={t("jobcards.partNo", locale)} htmlFor="line-partno">
              <Input id="line-partno" name="part_no" value={partNo} onChange={(e) => setPartNo(e.target.value)} />
            </Field>
            <Field label={t("jobcards.qty", locale)} htmlFor="line-qty">
              <Input id="line-qty" name="qty" type="number" inputMode="decimal" step="0.01" min="0.01" required value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            {costsVisible ? <Field label={t("jobcards.unitCost", locale)} htmlFor="line-unit">
              <Input id="line-unit" name="unit_cost" type="number" inputMode="decimal" step="0.01" min="0" value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field> : null}
          </div>
        </>
      ) : kind === "labour" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("jobcards.hours", locale)} htmlFor="line-hours">
            <Input id="line-hours" name="hours" type="number" inputMode="decimal" step="0.01" min="0.01" required value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          {costsVisible ? <Field label={t("jobcards.rate", locale)} htmlFor="line-rate">
            <Input id="line-rate" name="rate" type="number" inputMode="decimal" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field> : null}
        </div>
      ) : costsVisible ? (
        <Field label={t("jobcards.amount", locale)} htmlFor="line-amount">
          <Input id="line-amount" name="unit_cost" type="number" inputMode="decimal" step="0.01" min="0" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </Field>
      ) : null}

      {/* The 16px checkbox became the whole row, 48px, and it says what it means.
          The live preview used to read "R968.30 incl -> R842.00 ex + R126.30 vat". */}
      {costsVisible ? (
        <Checkbox name="incl_vat" value="1" checked={inclVat} onChange={(e) => setInclVat(e.target.checked)} label={t("jobcards.priceInclVat", locale)} />
      ) : null}

      {costsVisible && showPreview ? (
        <p className="text-sm text-sand-600" aria-live="polite">
          {inclVat
            ? t("jobcards.vatBreakdown", locale)
                .replace("{ex}", rands(exTotal))
                .replace("{vat}", rands(vatTotal))
            : t("jobcards.exOnly", locale).replace("{ex}", rands(exTotal))}
        </p>
      ) : null}

      <DialogActions cancelLabel={t("common.cancel", locale)}>{hasDraft ? <Button type="button" variant="ghost" onClick={discardDraft}>{t("jobcards.workflow.discardDraft", locale)}</Button> : null}<SubmitButton variant="primary" disabled={!loaded || draftConflict}>{t(line ? "jobcards.saveNow" : "jobcards.add", locale)}</SubmitButton></DialogActions>
      {queueError ? <p role="alert" className="text-sm text-status-overdue">{t("jobcards.workflow.queueFailed", locale)}</p> : null}
      {queued ? (
        <p role="status" className="text-sm font-medium text-status-due"><CheckIcon /> {t("offline.savedOffline", locale)}</p>
      ) : null}
    </form>
  );
}
