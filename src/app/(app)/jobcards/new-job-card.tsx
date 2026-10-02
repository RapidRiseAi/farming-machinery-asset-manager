"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { JOB_TYPES, type JobType } from "@/lib/job-options";
import { DialogActions, DialogFields, DialogForm } from "@/components/ui/dialog-form";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Button, type ButtonVariant, type ButtonSize } from "@/components/ui/button";
import { PlusIcon } from "@/components/ui/icons";
import { createJobCard } from "./actions";
import { createWorkRequest } from "../work/actions";

export type JobMachine = { id: string; name: string; farm_id: string; allowExternal?: boolean };
export type JobContractor = { id: string; name: string; farm_id: string };
type Props = {
  machines: JobMachine[]; contractors: JobContractor[]; isContractor: boolean; locale: Lang; actorId: string;
  defaultType?: JobType; sourceFault?: { id: string; description: string | null };
  triggerVariant?: ButtonVariant; triggerSize?: ButtonSize;
};
type IntakeDraft = {
  capture: string; mode: "internal" | "connected" | "external"; machineId: string; jobType: JobType;
  contractorId: string; providerName: string; description: string;
};
const isCapture = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function NewJobCard(props: Props) {
  return (
    <DialogForm trigger={t("jobcards.startNew", props.locale)} triggerVariant={props.triggerVariant} triggerSize={props.triggerSize} triggerIcon={<PlusIcon />} title={t("jobcards.startNew", props.locale)} closeLabel={t("ui.close", props.locale)} size="md">
      <IntakeForm {...props} />
    </DialogForm>
  );
}

// Mount only when a creation dialog opens. The same asset has several entry points,
// and closed dialogs must not overwrite another entry point's unfinished draft.
function IntakeForm({ machines, contractors, isContractor, locale, actorId, defaultType = "repair", sourceFault }: Props) {
  const key = `fleetwise:job-intake-draft:${actorId}:${sourceFault?.id ?? "general"}`;
  const uid = useId();
  const initial = JSON.stringify({ capture: "", mode: isContractor ? "external" : "internal", machineId: machines.length === 1 ? machines[0].id : "", jobType: defaultType, contractorId: "", providerName: "", description: sourceFault?.description ?? "" } satisfies IntakeDraft);
  const [draft, setDraft] = useState<IntakeDraft>(() => JSON.parse(initial));
  const [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    const fresh: IntakeDraft = { ...JSON.parse(initial), capture: crypto.randomUUID() };
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<IntakeDraft>;
        if (isCapture(saved.capture) && ["internal", "connected", "external"].includes(saved.mode ?? "")
          && JOB_TYPES.includes(saved.jobType as JobType)
          && [saved.machineId, saved.contractorId, saved.providerName, saved.description].every((value) => typeof value === "string")) {
          setDraft(saved as IntakeDraft);
          setRestored(true);
        } else setDraft(fresh);
      } else setDraft(fresh);
    } catch { setDraft(fresh); setStorageError(true); }
    setLoaded(true);
  }, [initial, key]);
  const persist = (next: IntakeDraft) => {
    try { localStorage.setItem(key, JSON.stringify(next)); setStorageError(false); }
    catch { setStorageError(true); }
  };
  const change = (patch: Partial<IntakeDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    persist(next);
  };
  const discard = () => {
    const fresh: IntakeDraft = { ...JSON.parse(initial), capture: crypto.randomUUID() };
    setDraft(fresh);
    setRestored(false);
    try { localStorage.removeItem(key); } catch { /* Online submission remains available. */ }
  };
  const machine = machines.find((entry) => entry.id === draft.machineId);
  const connected = draft.mode === "connected";
  const linked = contractors.filter((contractor) => contractor.farm_id === machine?.farm_id);
  const eligibleMachines = draft.mode !== "internal" && !isContractor ? machines.filter((entry) => entry.allowExternal) : machines;
  const unavailableDraft = restored && ((!!draft.machineId && !eligibleMachines.some((entry) => entry.id === draft.machineId)) || (isContractor && draft.mode !== "external"));

  return (
    <form action={connected ? createWorkRequest : createJobCard} onSubmit={() => persist(draft)} className="flex flex-col gap-4">
      <input type="hidden" name="intake_capture" value={draft.capture} />
      <input type="hidden" name="farm_id" value={machine?.farm_id ?? ""} />
      {sourceFault ? <input type="hidden" name="fault_id" value={sourceFault.id} /> : null}
      <input type="hidden" name="work_mode" value={draft.mode === "internal" ? "internal" : "external"} />
      {connected ? <><input type="hidden" name="kind" value={draft.jobType === "inspection" ? "inspection" : "repair"} /><input type="hidden" name="priority" value="normal" /></> : null}
      {restored ? <p role="status" className="text-sm text-sand-600">{t(unavailableDraft ? "jobcards.workflow.intakeDraftUnavailable" : "jobcards.draftRestored", locale)}</p> : null}
      {storageError ? <p role="status" className="text-sm text-status-due">{t("jobcards.workflow.draftStorageUnavailable", locale)}</p> : null}
      <fieldset disabled={!loaded || unavailableDraft} className="min-w-0">
        <DialogFields columns={1}>
          {!isContractor ? (
            <Field label={t("jobcards.workflow.whoWorks", locale)} htmlFor={`${uid}-mode`}>
              <Select id={`${uid}-mode`} value={draft.mode} onChange={(event) => {
                const mode = event.target.value as IntakeDraft["mode"];
                change({ mode, contractorId: "", machineId: mode !== "internal" && !machine?.allowExternal ? "" : draft.machineId });
              }}>
                <option value="internal">{t("jobcards.workflow.internal", locale)}</option>
                {machines.some((entry) => entry.allowExternal) ? <option value="connected">{t("jobcards.workflow.connected", locale)}</option> : null}
                {machines.some((entry) => entry.allowExternal) ? <option value="external">{t("jobcards.workflow.outside", locale)}</option> : null}
              </Select>
            </Field>
          ) : null}
          <p className="text-sm text-sand-600">{t(`jobcards.workflow.${isContractor ? "contractorCreateHint" : draft.mode + "Hint"}`, locale)}</p>
          <Field label={t("jobcards.whichMachineLabel", locale)} htmlFor={`${uid}-machine`} required>
            <Select id={`${uid}-machine`} name="machine_id" value={draft.machineId} onChange={(event) => change({ machineId: event.target.value, contractorId: "" })} required>
              <option value="" disabled>{t("jobcards.pickMachine", locale)}</option>
              {eligibleMachines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </Select>
          </Field>
          {connected ? linked.length > 0 ? (
            <Field label={t("work.contractor", locale)} htmlFor={`${uid}-contractor`} required>
              <Select id={`${uid}-contractor`} name="workshop_id" value={draft.contractorId} onChange={(event) => change({ contractorId: event.target.value })} required>
                <option value="" disabled>{t("jobcards.workflow.chooseContractor", locale)}</option>
                {linked.map((contractor) => <option key={contractor.id} value={contractor.id}>{contractor.name}</option>)}
              </Select>
            </Field>
          ) : machine ? <p className="text-sm text-sand-600">{t("work.noContractors", locale)} <Link href="/partners" className="focus-ring rounded font-medium text-brand-ink underline">{t("nav.partners", locale)}</Link></p> : null : draft.mode === "external" && !isContractor ? (
            <Field label={t("jobcards.workflow.providerName", locale)} htmlFor={`${uid}-provider`} required>
              <Input id={`${uid}-provider`} name="external_provider_name" value={draft.providerName} onChange={(event) => change({ providerName: event.target.value })} required maxLength={200} />
            </Field>
          ) : null}
          <Field label={t("jobcards.whatKindLabel", locale)} htmlFor={`${uid}-type`}>
            <Select id={`${uid}-type`} name={connected ? "job_type" : "type"} value={draft.jobType} onChange={(event) => change({ jobType: event.target.value as JobType })}>
              {JOB_TYPES.map((kind) => <option key={kind} value={kind}>{t(`jobType.${kind}`, locale)}</option>)}
            </Select>
          </Field>
          <Field label={t("jobcards.qWrong", locale)} htmlFor={`${uid}-reason`} required>
            <Textarea id={`${uid}-reason`} name={connected ? "description" : "reported_problem"} value={draft.description} onChange={(event) => change({ description: event.target.value })} rows={3} required />
          </Field>
        </DialogFields>
      </fieldset>
      <DialogActions cancelLabel={t("common.cancel", locale)}>
        <Button type="button" variant="ghost" disabled={!loaded} onClick={discard}>{t("jobcards.workflow.discardDraft", locale)}</Button>
        <SubmitButton variant="primary" disabled={!loaded || unavailableDraft || !machine || (connected && !linked.some((contractor) => contractor.id === draft.contractorId))}>{t(connected ? "work.send" : "jobcards.createIt", locale)}</SubmitButton>
      </DialogActions>
    </form>
  );
}
