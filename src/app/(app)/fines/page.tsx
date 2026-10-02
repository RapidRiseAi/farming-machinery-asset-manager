import Link from "next/link";
import { checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";
import { t } from "@/lib/i18n";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { errorMessage } from "@/lib/errors";
import {
  FINE_STATUSES,
  fineStatusLabel,
  fineStatusTone,
  nominationDeadlineStatus,
  nominationPending,
  DEFAULT_AARTO_LEAD_DAYS,
  type FineStatus as FineStatusValue,
} from "@/lib/fines";
import { expiryTone, expiryLabel } from "@/lib/compliance";
import { lapsedOn, type CredentialRow } from "@/lib/driver-credentials";
import { enumLabel, shortDate, todayLocal } from "@/lib/format";
import { createFine, identifyDriver, updateFineStatus, deleteFine } from "./actions";
import { UpgradeNotice } from "@/components/entitlement/upgrade-notice";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Flash } from "@/components/ui/flash";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState, AllClear } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { DialogActions, DialogFields, DialogForm, DialogSection } from "@/components/ui/dialog-form";
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

/**
 * The one-tap status changes offered in a fine's menu: the steps that usually come next.
 * "Driver identified" is not here, it goes through "Identify driver", which asks who.
 * "Update" in the same menu still reaches any status for the rare jump.
 */
const NEXT_STATUSES: Record<string, readonly FineStatusValue[]> = {
  received: ["nominated", "paid", "disputed"],
  driver_identified: ["nominated", "paid", "disputed"],
  nominated: ["paid", "disputed"],
  disputed: ["paid", "closed"],
  paid: ["closed"],
};


export default async function FinesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; sm?: string; sd?: string }>;
}) {
  // AARTO fine workflow is a Complete+ feature (FR-19.2). Deny server-side for under-plan
  // farms, fine data is never fetched; an upgrade prompt shows instead.
  const gate = await checkEntitlement("aarto");
  const profile = gate.profile;
  const locale = profile.lang;
  if (!gate.allowed) {
    return (
      <PageContainer size="wide">
        <PageHeader title={t("fines.title", locale)} infoKey="fines" locale={locale} />
        <UpgradeNotice feature="aarto" requiredPlan={gate.requiredPlan} currentPlan={gate.plan} locale={locale} />
      </PageContainer>
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

  // Every driver document on the farm, once, rather than a round trip per fine. RLS is what
  // decides how much of it comes back: owner and manager get the farm, anybody else gets
  // their own file, and a linked workshop gets nothing, so the warning below reaches
  // exactly the people already entitled to the dates behind it.
  let credentialsQ = supabase
    .from("driver_credentials")
    .select(
      "id, farm_id, user_id, person_name, type, code, number, issued_on, expiry_date, reminder_lead_days, notes",
    )
    .is("deleted_at", null);
  if (farmId) credentialsQ = credentialsQ.eq("farm_id", farmId);

  const [machinesRes, opsRes, finesRes, farmRes, credentialsRes] = await Promise.all([
    machinesQ,
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    finesQ,
    supabase.from("farms").select("settings").eq("id", farmId ?? profile.farm_id ?? "").maybeSingle(),
    credentialsQ,
  ]);
  const credentials = (credentialsRes.data as CredentialRow[] | null) ?? [];

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

  // == Driver auto-suggestion (FR-13.1 → FR-13.2): usage_logs for the chosen vehicle on the
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
  // Never the raw URL value: actions used to put Postgres messages there.
  const errMsg = sp.error === "upgrade_required" ? t("fines.upgradeRequired", locale) : errorMessage(sp.error, locale);

  const renderFineCard = (f: FineRow) => {
    const ds = nominationDeadlineStatus(f.nomination_deadline, f.status, leadDays);
    return (
      // The id is the dashboard's "Name the driver" target (/fines#fine-<id>);
      // scroll-mt clears the sticky header, the same offset /faults uses.
      <li key={f.id} id={`fine-${f.id}`} className="scroll-mt-24 rounded-lg border border-sand-200 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={`/machines/${f.machine_id}`} className="focus-ring rounded font-medium text-brand-ink hover:underline">
              {machineLabel(f.machine_id)}
            </Link>
            <p className="mt-0.5 text-sm text-sand-700">
              {f.offence || t("fines.noOffence", locale)}
              {f.authority ? <span className="text-sand-500"> · {f.authority}</span> : null}
              {f.notice_number ? <span className="text-sand-400"> · {f.notice_number}</span> : null}
            </p>
            <p className="mt-0.5 text-xs text-sand-500">
              {f.offence_date ? <>{t("fines.offenceDate", locale)}: <span className="tabular-nums">{shortDate(f.offence_date, locale)}</span> · </> : null}
              {t("fines.driver", locale)}: <span className="font-medium text-sand-700">{driverText(f)}</span>
              {f.amount_cents != null ? <> · <span className="tabular-nums">{rands(f.amount_cents)}</span></> : null}
            </p>
            {f.nomination_deadline ? (
              <p className="mt-0.5 text-xs text-sand-500">
                {t("fines.deadline", locale)}: <span className="tabular-nums">{shortDate(f.nomination_deadline, locale)}</span>
                {ds ? <> · <ExpiryStatus value={ds} locale={locale} /></> : null}
              </p>
            ) : null}
            {f.notes ? <p className="mt-0.5 text-xs text-sand-500">{f.notes}</p> : null}

            {/* The thing this whole feature exists to say. A nomination names somebody to
                the authority as the person who was driving; if their own licence or PrDP
                had already lapsed on the day of the offence, the farm is about to put that
                in writing. Asked about the OFFENCE DATE, not about today, because "their
                licence is fine now" is not an answer to it.

                Shown for pending nominations only. A fine already nominated or paid is a
                closed matter, and a red box on it is noise on a screen whose two loud
                things need to stay loud. */}
            {(() => {
              if (!f.offence_date || !nominationPending(f.status)) return null;
              const lapses = lapsedOn(
                credentials,
                { userId: f.driver_user_id, name: f.driver_name },
                f.offence_date,
              );
              if (lapses.length === 0) return null;
              return (
                <div className="mt-2 rounded-lg border border-callout-danger-edge bg-callout-danger-bg px-3 py-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-callout-danger-ink">
                    {t("credentials.lapsedLead", locale)}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {lapses.map((c) => (
                      <li key={c.id} className="text-sm leading-relaxed text-callout-danger-ink">
                        {t("credentials.lapsedWarning", locale)
                          .replace("{person}", driverText(f))
                          .replace("{credential}", enumLabel("credentialType", c.type, locale))
                          .replace("{date}", shortDate(f.offence_date, locale))}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <FineStatus value={f.status} locale={locale} />

            {/*
              Set the status, name the driver, delete: one button per row, in the row's
              own title line (as on /incidents) rather than on a divided strip of its own.

              The row used to carry a `<Select>` of all seven fine statuses next to a Save
              button, plus a `<details>` holding a two-field driver form, plus a delete.
              The likely next steps are now one tap each; "Update" stays for the rare jump.
            */}
            {canManage ? (
            <ActionMenu
              title={f.notice_number ? `${f.notice_number} · ${machineLabel(f.machine_id)}` : machineLabel(f.machine_id)}
              label={t("common.actions", locale)}
              closeLabel={t("ui.close", locale)}
            >
              {(NEXT_STATUSES[f.status] ?? []).map((next) => (
                <form key={next} action={updateFineStatus}>
                  <input type="hidden" name="id" value={f.id} />
                  <input type="hidden" name="status" value={next} />
                  <SubmitButton look="menuItem">
                    {t("fines.markAs", locale).replace("{status}", fineStatusLabel(next, locale))}
                  </SubmitButton>
                </form>
              ))}
              <DialogForm
                triggerLook="menuItem"
                trigger={t("fines.setStatus", locale)}
                title={t("fines.setStatus", locale)}
                description={f.notice_number ?? undefined}
                closeLabel={t("ui.close", locale)}
                size="md"
              >
                <form action={updateFineStatus}>
                  <input type="hidden" name="id" value={f.id} />
                  <DialogFields columns={1}>
                    <Field label={t("fines.status", locale)} htmlFor={`st-${f.id}`}>
                      <Select id={`st-${f.id}`} name="status" defaultValue={f.status}>
                        {FINE_STATUSES.map((s) => (
                          <option key={s} value={s}>{fineStatusLabel(s, locale)}</option>
                        ))}
                      </Select>
                    </Field>
                  </DialogFields>
                  <DialogActions cancelLabel={t("common.cancel", locale)}>
                    <SubmitButton variant="primary">{t("fines.setStatus", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>

              {nominationPending(f.status) ? (
                <DialogForm
                  triggerLook="menuItem"
                  trigger={t("fines.identifyDriver", locale)}
                  title={t("fines.identifyDriver", locale)}
                  description={f.notice_number ?? undefined}
                  closeLabel={t("ui.close", locale)}
                  size="md"
                >
                  <form action={identifyDriver}>
                    <input type="hidden" name="id" value={f.id} />
                    <DialogFields>
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
                    </DialogFields>
                    <DialogActions cancelLabel={t("common.cancel", locale)}>
                      <SubmitButton variant="primary">{t("common.save", locale)}</SubmitButton>
                    </DialogActions>
                  </form>
                </DialogForm>
              ) : null}

              <ConfirmDialog
                action={deleteFine}
                triggerLook="menuItem"
                triggerIcon={<TrashIcon />}
                triggerLabel={t("common.delete", locale)}
                title={t("confirm.deleteFineTitle", locale)}
                intro={
                  f.notice_number
                    ? t("confirm.deleteFineIntro", locale)
                        .replace("{notice}", f.notice_number)
                        .replace("{machine}", machineLabel(f.machine_id))
                    : t("confirm.deleteFineIntroNoNotice", locale).replace("{machine}", machineLabel(f.machine_id))
                }
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
            </ActionMenu>
            ) : null}
          </div>
        </div>
      </li>
    );
  };

  const stepTwo = Boolean(sm && sd && captureMachine);

  return (
    <PageContainer size="wide">
      <PageHeader
        title={t("fines.title", locale)}
        lead={t("fines.subtitle", locale)}
        infoKey="fines"
        locale={locale}
        badge={
          pending.length > 0 ? (
            <StatusBadge
              tone="warning"
              shape="clock"
              label={t("fines.pendingCount", locale).replace("{n}", String(pending.length))}
            />
          ) : undefined
        }
      />

      <Flash tone="error" message={errMsg} />
      <Flash tone="success" message={savedMsg} />

      {/* == Capture: pick a vehicle + offence date, then the driver is suggested == */}
      {canManage ? (
        <Card>
          <CardHeader><CardTitle>{t("fines.captureTitle", locale)}</CardTitle></CardHeader>
          <p className="mb-3 text-sm text-sand-500">{t("fines.captureHint", locale)}</p>

          {/* Step 1, which vehicle & when (drives the usage-log lookup). A GET form on the
              page by agreement: it is a lookup, not a capture. */}
          <form method="get" className={`flex flex-wrap items-end gap-2${stepTwo ? " border-b border-sand-100 pb-3" : ""}`}>
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

          {stepTwo && sm && sd && captureMachine ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 text-sm text-sand-700">
                {topSuggestion ? (
                  <>
                    {t("fines.suggested", locale)}:{" "}
                    <span className="font-semibold">{suggestionNames.join(", ")}</span>
                    {" · "}
                  </>
                ) : null}
                <span className="text-sand-500">{machineLabel(sm)} · {shortDate(sd, locale)}</span>
              </p>

              {/* Step 2, the capture itself, opens as a dialog on arrival from step 1, with
                  the driver pre-filled from the usage log. It used to grow ten fields onto
                  the page. Dismissed, its trigger here reopens it. */}
              <DialogForm
                defaultOpen
                trigger={t("fines.continueRecording", locale)}
                title={t("fines.captureTitle", locale)}
                description={`${machineLabel(sm)} · ${shortDate(sd, locale)}`}
                closeLabel={t("ui.close", locale)}
              >
                <form action={createFine}>
                  <input type="hidden" name="machine_id" value={sm} />
                  <input type="hidden" name="farm_id" value={captureMachine.farm_id} />
                  <input type="hidden" name="offence_date" value={sd} />
                  <DialogFields>
                    {topSuggestion ? (
                      <p className="rounded-lg bg-brand-tint p-3 text-sm text-brand-ink sm:col-span-2">
                        {t("fines.suggested", locale)}:{" "}
                        <span className="font-semibold">{suggestionNames.join(", ")}</span>
                      </p>
                    ) : (
                      <p className="rounded-lg bg-sand-50 p-3 text-sm text-sand-600 sm:col-span-2">{t("fines.noSuggestion", locale)}</p>
                    )}
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
                    <Field label={t("fines.offence", locale)} htmlFor="offence">
                      <Input id="offence" name="offence" placeholder={t("fines.offencePlaceholder", locale)} />
                    </Field>
                    <Field label={t("fines.amount", locale)} htmlFor="amount">
                      <Input id="amount" name="amount" inputMode="decimal" placeholder="R" />
                    </Field>
                    <DialogSection title={t("fines.sectionMore", locale)}>
                      <Field label={t("fines.fineDate", locale)} htmlFor="fine_date">
                        <Input id="fine_date" name="fine_date" type="date" defaultValue={todayLocal()} />
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
                      <Field label={t("fines.notes", locale)} htmlFor="notes">
                        <Input id="notes" name="notes" placeholder={t("fines.notesPlaceholder", locale)} />
                      </Field>
                    </DialogSection>
                  </DialogFields>
                  <DialogActions cancelLabel={t("common.cancel", locale)}>
                    <SubmitButton variant="primary">{t("fines.record", locale)}</SubmitButton>
                  </DialogActions>
                </form>
              </DialogForm>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* == Pending nominations & deadlines (§23) == */}
      <Card>
        <CardHeader><CardTitle>{t("fines.pendingTitle", locale)}</CardTitle></CardHeader>
        {pending.length === 0 ? (
          <AllClear title={t("fines.noPending", locale)} />
        ) : (
          <ul className="flex flex-col gap-2">{pending.map(renderFineCard)}</ul>
        )}
      </Card>

      {/* == Resolved / historical fines == */}
      {resolved.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>{t("fines.otherTitle", locale)}</CardTitle></CardHeader>
          <ul className="flex flex-col gap-2">{resolved.map(renderFineCard)}</ul>
        </Card>
      ) : null}

      {fines.length === 0 && !canManage ? (
        <EmptyState title={t("fines.empty", locale)} />
      ) : null}
    </PageContainer>
  );
}
