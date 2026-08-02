import Link from "next/link";
import { checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import {
  FINE_STATUSES,
  fineStatusLabel,
  fineStatusTone,
  nominationDeadlineStatus,
  nominationPending,
  DEFAULT_AARTO_LEAD_DAYS,
} from "@/lib/fines";
import { expiryTone, expiryLabel } from "@/lib/compliance";
import { createFine, identifyDriver, updateFineStatus, deleteFine } from "./actions";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ExpiryStatus, FineStatus } from "@/components/ui/status";
import { TrashIcon } from "@/components/ui/icons";

type MachineRow = { id: string; farm_id: string; name: string; reg_no: string | null; status: string };
type OperatorRow = { id: string; name: string };
type FineRow = {
  id: string; machine_id: string; notice_number: string | null; authority: string | null;
  offence: string | null; offence_date: string | null; fine_date: string; amount_cents: number | null;
  nomination_deadline: string | null; status: string; driver_user_id: string | null; driver_name: string | null;
  notes: string | null; created_at: string;
};
type UsageRow = { driver_user_id: string | null; driver_name: string | null; meter_reading: number | null };

const inputCls = "rounded-lg border border-sand-300 px-3 py-2 text-sm";

export default async function FinesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; sm?: string; sd?: string }>;
}) {
  // AARTO fine workflow is a Complete+ feature (FR-19.2). Deny server-side for under-plan
  // farms — fine data is never fetched; an upgrade prompt shows instead.
  const gate = await checkEntitlement("aarto");
  const profile = gate.profile;
  const locale = profile.language;
  if (!gate.allowed) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("fines.title", locale)}</h1>
        <UpgradeNotice feature="aarto" requiredPlan={gate.requiredPlan} currentPlan={gate.plan} locale={locale} />
      </div>
    );
  }

  const canManage = profile.role === "owner" || profile.role === "manager";
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  const supabase = await createClient();

  let machinesQ = supabase
    .from("machines")
    .select("id, farm_id, name, reg_no, status")
    .is("deleted_at", null)
    .order("name");
  if (farmId) machinesQ = machinesQ.eq("farm_id", farmId);

  let finesQ = supabase
    .from("fines")
    .select("id, machine_id, notice_number, authority, offence, offence_date, fine_date, amount_cents, nomination_deadline, status, driver_user_id, driver_name, notes, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (farmId) finesQ = finesQ.eq("farm_id", farmId);

  const [machinesRes, opsRes, finesRes, farmRes] = await Promise.all([
    machinesQ,
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    finesQ,
    supabase.from("farms").select("settings").eq("id", farmId ?? profile.farm_id ?? "").maybeSingle(),
  ]);

  const machines = (machinesRes.data as MachineRow[] | null) ?? [];
  const operators = (opsRes.data as OperatorRow[] | null) ?? [];
  const fines = (finesRes.data as FineRow[] | null) ?? [];
  const farmSettings = ((farmRes.data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const leadDays = Number(farmSettings.aarto_nomination_lead_days) || DEFAULT_AARTO_LEAD_DAYS;

  const machineById = new Map(machines.map((m) => [m.id, m]));
  const operatorName = new Map(operators.map((o) => [o.id, o.name]));
  const machineLabel = (id: string) => {
    const m = machineById.get(id);
    if (!m) return t("fines.unknownVehicle", locale);
    return m.reg_no ? `${m.name} · ${m.reg_no}` : m.name;
  };
  const driverText = (f: { driver_user_id: string | null; driver_name: string | null }) =>
    (f.driver_user_id ? operatorName.get(f.driver_user_id) : null) ?? f.driver_name ?? t("fines.driverUnknown", locale);

  // ── Driver auto-suggestion (FR-13.1 → FR-13.2): usage_logs for the chosen vehicle on the
  // chosen offence date. This is the heart of "who was driving vehicle X on date D?".
  const sm = sp.sm && machineById.has(sp.sm) ? sp.sm : null;
  const sd = sp.sd && /^\d{4}-\d{2}-\d{2}$/.test(sp.sd) ? sp.sd : null;
  let suggestions: UsageRow[] = [];
  if (sm && sd) {
    const { data: usage } = await supabase
      .from("usage_logs")
      .select("driver_user_id, driver_name, meter_reading")
      .eq("machine_id", sm)
      .eq("occurred_on", sd)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    suggestions = (usage as UsageRow[] | null) ?? [];
  }
  const topSuggestion = suggestions[0] ?? null;
  const suggestionNames = suggestions.map(driverText).filter((v, i, a) => a.indexOf(v) === i);
  const captureMachine = sm ? machineById.get(sm) ?? null : null;

  // Pending nominations (§23) sort to the top, soonest deadline first; the rest by recency.
  const pending = fines.filter((f) => nominationPending(f.status));
  const resolved = fines.filter((f) => !nominationPending(f.status));
  const deadlineRank = (f: FineRow) => f.nomination_deadline ?? "9999-99-99";
  pending.sort((a, b) => deadlineRank(a).localeCompare(deadlineRank(b)));

  const savedMsg = sp.saved ? t("ui.saved", locale) : undefined;
  const errMsg = sp.error === "upgrade_required" ? t("fines.upgradeRequired", locale) : sp.error;

  const renderFineCard = (f: FineRow) => {
    const ds = nominationDeadlineStatus(f.nomination_deadline, f.status, leadDays);
    return (
      <li key={f.id} className="rounded-lg border border-sand-200 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/machines/${f.machine_id}`} className="focus-ring rounded font-medium text-brand-700 hover:underline">
              {machineLabel(f.machine_id)}
            </Link>
            <p className="mt-0.5 text-sm text-sand-700">
              {f.offence || t("fines.noOffence", locale)}
              {f.authority ? <span className="text-sand-500"> · {f.authority}</span> : null}
              {f.notice_number ? <span className="text-sand-400"> · {f.notice_number}</span> : null}
            </p>
            <p className="mt-0.5 text-xs text-sand-500">
              {f.offence_date ? <>{t("fines.offenceDate", locale)}: <span className="tabular-nums">{f.offence_date}</span> · </> : null}
              {t("fines.driver", locale)}: <span className="font-medium text-sand-700">{driverText(f)}</span>
              {f.amount_cents != null ? <> · <span className="tabular-nums">{rands(f.amount_cents)}</span></> : null}
            </p>
            {f.nomination_deadline ? (
              <p className="mt-0.5 text-xs text-sand-500">
                {t("fines.deadline", locale)}: <span className="tabular-nums">{f.nomination_deadline}</span>
                {ds ? <> · <ExpiryStatus value={ds} locale={locale} /></> : null}
              </p>
            ) : null}
            {f.notes ? <p className="mt-0.5 text-xs text-sand-500">{f.notes}</p> : null}
          </div>
          <FineStatus value={f.status} locale={locale} />
        </div>

        {canManage ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-sand-100 pt-2">
            {/* Change status */}
            <form action={updateFineStatus} className="flex items-center gap-1.5">
              <input type="hidden" name="id" value={f.id} />
              <Select name="status" defaultValue={f.status} className="text-sm">
                {FINE_STATUSES.map((s) => (
                  <option key={s} value={s}>{fineStatusLabel(s, locale)}</option>
                ))}
              </Select>
              <SubmitButton variant="secondary" size="sm">{t("fines.setStatus", locale)}</SubmitButton>
            </form>

            {/* Identify / re-assign the driver */}
            {nominationPending(f.status) ? (
              <details>
                <summary className="cursor-pointer text-xs font-medium text-brand-700">{t("fines.identifyDriver", locale)}</summary>
                <form action={identifyDriver} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={f.id} />
                  <Field label={t("fines.driver", locale)} htmlFor={`d-${f.id}`}>
                    <Select id={`d-${f.id}`} name="driver_user_id" defaultValue={f.driver_user_id ?? ""}>
                      <option value="">{t("fines.driverNameOption", locale)}</option>
                      {operators.map((op) => (
                        <option key={op.id} value={op.id}>{op.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("fines.driverName", locale)} htmlFor={`dn-${f.id}`}>
                    <Input id={`dn-${f.id}`} name="driver_name" defaultValue={f.driver_name ?? ""} placeholder={t("fines.driverNamePlaceholder", locale)} />
                  </Field>
                  <SubmitButton variant="primary" size="sm">{t("common.save", locale)}</SubmitButton>
                </form>
              </details>
            ) : null}

            <div className="ml-auto">
              <ConfirmDialog
                action={deleteFine}
                triggerVariant="ghost"
                triggerSize="sm"
                triggerIcon={<TrashIcon />}
                triggerLabel={t("common.delete", locale)}
                triggerClassName="text-status-overdue hover:bg-red-50"
                title={t("confirm.deleteFineTitle", locale)}
                intro={t("confirm.deleteFineIntro", locale)
                  .replace("{notice}", f.notice_number ?? "—")
                  .replace("{machine}", machineById.get(f.machine_id)?.name ?? "—")}
                consequencesTitle={t("confirm.whatHappens", locale)}
                consequences={[
                  t("confirm.deleteFineEffect1", locale),
                  t("confirm.deleteFineEffect2", locale),
                ]}
                footnote={t("confirm.softDeleteNote", locale)}
                confirmLabel={t("confirm.deleteFineYes", locale)}
                cancelLabel={t("confirm.keepIt", locale)}
                closeLabel={t("ui.close", locale)}
              >
                <input type="hidden" name="id" value={f.id} />
              </ConfirmDialog>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-sand-900">{t("fines.title", locale)}</h1>
          <p className="mt-0.5 text-sm text-sand-500">{t("fines.subtitle", locale)}</p>
        </div>
        {pending.length > 0 ? (
          <Badge tone="warning">{t("fines.pendingCount", locale).replace("{n}", String(pending.length))}</Badge>
        ) : null}
      </div>

      <Flash tone="error" message={errMsg} />
      <Flash tone="success" message={savedMsg} />

      {/* ── Capture: pick a vehicle + offence date → auto-suggest the driver ── */}
      {canManage ? (
        <Card>
          <CardHeader><CardTitle>{t("fines.captureTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-500">{t("fines.captureHint", locale)}</p>

          {/* Step 1 — which vehicle & when (drives the usage-log lookup). */}
          <form method="get" className="flex flex-wrap items-end gap-2 border-b border-sand-100 pb-3">
            <Field label={t("fines.vehicle", locale)} htmlFor="sm" className="min-w-[12rem] flex-1">
              <Select id="sm" name="sm" defaultValue={sm ?? ""} required>
                <option value="" disabled>{t("fines.selectVehicle", locale)}</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>{m.reg_no ? `${m.name} · ${m.reg_no}` : m.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("fines.offenceDate", locale)} htmlFor="sd">
              <Input id="sd" name="sd" type="date" defaultValue={sd ?? ""} required />
            </Field>
            <SubmitButton variant="secondary">{t("fines.findDriver", locale)}</SubmitButton>
          </form>

          {sm && sd && captureMachine ? (
            <div className="mt-3">
              {/* Suggestion result. */}
              {topSuggestion ? (
                <p className="mb-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-900">
                  {t("fines.suggested", locale)}:{" "}
                  <span className="font-semibold">{suggestionNames.join(", ")}</span>
                  <span className="text-brand-700/70"> · {machineLabel(sm)} · {sd}</span>
                </p>
              ) : (
                <p className="mb-3 rounded-lg bg-sand-50 p-3 text-sm text-sand-600">{t("fines.noSuggestion", locale)}</p>
              )}

              {/* Step 2 — full capture, driver pre-filled from the usage log. */}
              <form action={createFine} className="flex flex-col gap-3">
                <input type="hidden" name="machine_id" value={sm} />
                <input type="hidden" name="farm_id" value={captureMachine.farm_id} />
                <input type="hidden" name="offence_date" value={sd} />

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("fines.driver", locale)} htmlFor="driver_user_id">
                    <Select id="driver_user_id" name="driver_user_id" defaultValue={topSuggestion?.driver_user_id ?? ""}>
                      <option value="">{t("fines.driverNameOption", locale)}</option>
                      {operators.map((op) => (
                        <option key={op.id} value={op.id}>{op.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("fines.driverName", locale)} htmlFor="driver_name">
                    <Input id="driver_name" name="driver_name" defaultValue={topSuggestion && !topSuggestion.driver_user_id ? topSuggestion.driver_name ?? "" : ""} placeholder={t("fines.driverNamePlaceholder", locale)} />
                  </Field>
                  <Field label={t("fines.noticeNumber", locale)} htmlFor="notice_number">
                    <Input id="notice_number" name="notice_number" placeholder={t("fines.noticeNumberPlaceholder", locale)} />
                  </Field>
                  <Field label={t("fines.authority", locale)} htmlFor="authority">
                    <Input id="authority" name="authority" placeholder={t("fines.authorityPlaceholder", locale)} />
                  </Field>
                  <Field label={t("fines.offence", locale)} htmlFor="offence" className="sm:col-span-2">
                    <Input id="offence" name="offence" placeholder={t("fines.offencePlaceholder", locale)} />
                  </Field>
                  <Field label={t("fines.amount", locale)} htmlFor="amount">
                    <Input id="amount" name="amount" inputMode="decimal" placeholder="R" />
                  </Field>
                  <Field label={t("fines.fineDate", locale)} htmlFor="fine_date">
                    <Input id="fine_date" name="fine_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
                  </Field>
                  <Field label={t("fines.deadline", locale)} htmlFor="nomination_deadline">
                    <Input id="nomination_deadline" name="nomination_deadline" type="date" />
                  </Field>
                  <Field label={t("fines.status", locale)} htmlFor="status">
                    <Select id="status" name="status" defaultValue={topSuggestion ? "driver_identified" : "received"}>
                      {FINE_STATUSES.map((s) => (
                        <option key={s} value={s}>{fineStatusLabel(s, locale)}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("fines.notes", locale)} htmlFor="notes" className="sm:col-span-2">
                    <Input id="notes" name="notes" placeholder={t("fines.notesPlaceholder", locale)} />
                  </Field>
                </div>
                <SubmitButton variant="primary" className="self-start">{t("fines.record", locale)}</SubmitButton>
              </form>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ── Pending nominations & deadlines (§23) ── */}
      <Card>
        <CardHeader><CardTitle>{t("fines.pendingTitle", locale)}</CardTitle></CardHeader>
        {pending.length === 0 ? (
          <EmptyState title={t("fines.noPending", locale)} />
        ) : (
          <ul className="flex flex-col gap-2">{pending.map(renderFineCard)}</ul>
        )}
      </Card>

      {/* ── Resolved / historical fines ── */}
      {resolved.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("fines.otherTitle", locale)}</CardTitle></CardHeader>
          <ul className="flex flex-col gap-2">{resolved.map(renderFineCard)}</ul>
        </Card>
      ) : null}

      {fines.length === 0 && !canManage ? (
        <EmptyState title={t("fines.empty", locale)} />
      ) : null}
    </div>
  );
}
