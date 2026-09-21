import Link from "next/link";

import { currentFarmId, requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { enumLabel, shortDate } from "@/lib/format";
import {
  INCIDENT_COLUMNS,
  INCIDENT_KINDS,
  INCIDENT_STATUSES,
  claimOpen,
  daysWaiting,
  incidentLook,
  incidentOpen,
  incidentOrder,
  outstandingClaimCents,
  type IncidentRow,
} from "@/lib/incidents";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { GetStarted } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { ChevronDownIcon, TrashIcon } from "@/components/ui/icons";

import { recordIncident, removeIncident, updateIncident } from "./actions";

export const dynamic = "force-dynamic";

type MachineRow = { id: string; name: string; reg_no: string | null };
type PersonRow = { id: string; name: string | null };
type JobCardRow = { id: string; machine_id: string; type: string; date_in: string | null };

/**
 * Accidents, and the insurance claim that follows one.
 *
 * ── WHY IT IS NOT A FAULT ────────────────────────────────────────────────────
 * A fault is "something stopped working and somebody must fix it". An accident has a SAPS
 * case number, another driver with their own insurer, an excess, and a settlement that
 * arrives months later. Kept in the notes field of a fault, none of that is ever chased.
 *
 * ── THE NUMBER AT THE TOP ────────────────────────────────────────────────────
 * What the insurer still owes. Only claims that are LODGED count towards it — not
 * rejected, not settled, not the ones a farm decided were below the excess — so that the
 * figure is one a person can hold up against a single letter from their broker.
 *
 * ── THE MONEY IS VAT-INCLUSIVE ───────────────────────────────────────────────
 * Unlike everything else in this product. These are figures copied off an insurer's
 * letter, and a screen that re-based them would disagree with the document on every line.
 * Said in words under the form rather than assumed.
 */
export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; edit?: string }>;
}) {
  const profile = await requireProfile();
  const locale = profile.lang;
  const sp = await searchParams;
  const farmId = await currentFarmId(profile);
  const canManage = profile.role === "owner" || profile.role === "manager";

  const supabase = await createClient();

  let incidentsQ = supabase.from("incidents").select(INCIDENT_COLUMNS).is("deleted_at", null);
  let machinesQ = supabase
    .from("machines")
    .select("id, name, reg_no")
    .is("deleted_at", null)
    .order("name");
  let jobCardsQ = supabase
    .from("job_cards")
    .select("id, machine_id, type, date_in")
    .is("deleted_at", null)
    .order("date_in", { ascending: false })
    .limit(200);
  if (farmId) {
    incidentsQ = incidentsQ.eq("farm_id", farmId);
    machinesQ = machinesQ.eq("farm_id", farmId);
    jobCardsQ = jobCardsQ.eq("farm_id", farmId);
  }

  const [incidentsRes, machinesRes, peopleRes, jobCardsRes] = await Promise.all([
    incidentsQ,
    machinesQ,
    supabase.from("users").select("id, name").eq("active", true).is("deleted_at", null).order("name"),
    jobCardsQ,
  ]);

  const incidents = ((incidentsRes.data as IncidentRow[] | null) ?? [])
    .slice()
    .sort((a, b) => incidentOrder(a, b));
  const machines = (machinesRes.data as MachineRow[] | null) ?? [];
  const people = (peopleRes.data as PersonRow[] | null) ?? [];
  const jobCards = (jobCardsRes.data as JobCardRow[] | null) ?? [];

  const machineById = new Map(machines.map((m) => [m.id, m]));
  const personName = new Map(people.map((p) => [p.id, p.name ?? ""]));
  const machineLabel = (id: string) => {
    const m = machineById.get(id);
    if (!m) return t("fines.unknownVehicle", locale);
    return m.reg_no ? `${m.name} · ${m.reg_no}` : m.name;
  };
  const driverText = (r: IncidentRow) =>
    (r.driver_user_id ? personName.get(r.driver_user_id) : null) || r.driver_name || "";

  const stillOpen = incidents.filter((r) => incidentOpen(r.status)).length;
  const owed = outstandingClaimCents(incidents);
  const longest = incidents.reduce<number | null>((worst, r) => {
    const d = daysWaiting(r);
    return d != null && (worst == null || d > worst) ? d : worst;
  }, null);

  const editing = sp.edit ? incidents.find((r) => r.id === sp.edit) ?? null : null;

  /** The claim fields, shared by the capture form and the update form. */
  const claimFields = (row: IncidentRow | null, prefix: string) => (
    <>
      <Field label={t("incidents.fieldInsurer", locale)} htmlFor={`${prefix}-insurer`}>
        <Input id={`${prefix}-insurer`} name="insurer" defaultValue={row?.insurer ?? ""} maxLength={60} />
      </Field>
      <Field label={t("incidents.fieldClaimNumber", locale)} htmlFor={`${prefix}-claim`}>
        <Input id={`${prefix}-claim`} name="claim_number" defaultValue={row?.claim_number ?? ""} maxLength={40} />
      </Field>
      <Field label={t("incidents.fieldLodgedOn", locale)} htmlFor={`${prefix}-lodged`}>
        <Input id={`${prefix}-lodged`} name="claim_lodged_on" type="date" defaultValue={row?.claim_lodged_on ?? ""} />
      </Field>
      <Field label={t("incidents.fieldExcess", locale)} htmlFor={`${prefix}-excess`}>
        <Input
          id={`${prefix}-excess`}
          name="excess_incl_cents"
          inputMode="decimal"
          defaultValue={row?.excess_incl_cents != null ? String(row.excess_incl_cents / 100) : ""}
        />
      </Field>
      <Field label={t("incidents.fieldClaimed", locale)} htmlFor={`${prefix}-claimed`}>
        <Input
          id={`${prefix}-claimed`}
          name="claimed_incl_cents"
          inputMode="decimal"
          defaultValue={row?.claimed_incl_cents != null ? String(row.claimed_incl_cents / 100) : ""}
        />
      </Field>
      <Field label={t("incidents.fieldSettled", locale)} htmlFor={`${prefix}-settled`}>
        <Input
          id={`${prefix}-settled`}
          name="settled_incl_cents"
          inputMode="decimal"
          defaultValue={row?.settled_incl_cents != null ? String(row.settled_incl_cents / 100) : ""}
        />
      </Field>
      <Field label={t("incidents.fieldSettledOn", locale)} htmlFor={`${prefix}-settledon`}>
        <Input id={`${prefix}-settledon`} name="settled_on" type="date" defaultValue={row?.settled_on ?? ""} />
      </Field>
      <Field label={t("incidents.fieldJobCard", locale)} htmlFor={`${prefix}-jc`}>
        <Select id={`${prefix}-jc`} name="job_card_id" defaultValue={row?.job_card_id ?? ""}>
          <option value="">{t("incidents.fieldJobCardNone", locale)}</option>
          {jobCards.map((j) => (
            <option key={j.id} value={j.id}>
              {machineLabel(j.machine_id)} · {j.date_in ? shortDate(j.date_in, locale) : "—"}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight text-ink">
            {t("incidents.title", locale)}
          </h1>
          <PageInfoButton infoKey="incidents" locale={locale} />
        </div>
        <p className="mt-1 text-sm text-sand-600">{t("incidents.lead", locale)}</p>
      </div>

      <Flash tone="error" message={errorMessage(sp.error, locale)} />
      <Flash
        tone="success"
        message={
          sp.saved === "incident-added"
            ? t("incidents.savedAdded", locale)
            : sp.saved === "incident-updated"
              ? t("incidents.savedUpdated", locale)
              : sp.saved === "incident-removed"
                ? t("incidents.savedRemoved", locale)
                : undefined
        }
      />

      {/* The three answers, above the list. "Owed by insurer" is the one this page exists
          for, and "longest wait" is the one that makes somebody ring the broker. */}
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label={t("incidents.statOpen", locale)}
          value={String(stillOpen)}
          tone={stillOpen > 0 ? "due" : "default"}
        />
        <Stat
          label={t("incidents.statOutstanding", locale)}
          value={rands(owed)}
          tone={owed > 0 ? "brand" : "default"}
        />
        <Stat
          label={t("incidents.statWaiting", locale)}
          value={
            longest == null
              ? t("incidents.waitingNone", locale)
              : t("incidents.waitingDays", locale).replace("{n}", String(longest))
          }
          tone={longest != null && longest >= 30 ? "overdue" : "default"}
        />
      </div>

      {incidents.length === 0 ? (
        <GetStarted
          title={t("incidents.emptyTitle", locale)}
          hint={t("incidents.emptyBody", locale)}
        />
      ) : (
        <Card flush>
          <div className="p-4 pb-0 sm:p-5 sm:pb-0">
            <CardTitle>{t("incidents.listTitle", locale)}</CardTitle>
          </div>
          <ul className="divide-y divide-sand-200">
            {incidents.map((r) => {
              const look = incidentLook(r.status);
              const waiting = daysWaiting(r);
              return (
                <li key={r.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/machines/${r.machine_id}`}
                        className="focus-ring rounded font-semibold text-brand-ink hover:underline"
                      >
                        {machineLabel(r.machine_id)}
                      </Link>
                      <p className="mt-0.5 text-sm text-sand-700">
                        {enumLabel("incidentKind", r.kind, locale)}
                        <span className="text-sand-500"> · {shortDate(r.occurred_at, locale)}</span>
                        {r.location ? <span className="text-sand-500"> · {r.location}</span> : null}
                      </p>
                    </div>
                    <Badge tone={look.tone}>{t(look.labelKey, locale)}</Badge>
                  </div>

                  {r.description ? (
                    <p className="mt-2 text-sm leading-relaxed text-sand-700">{r.description}</p>
                  ) : null}

                  <p className="mt-1.5 text-xs text-sand-500">
                    {driverText(r) ? (
                      <>
                        {t("incidents.driver", locale)}:{" "}
                        <span className="font-medium text-sand-700">{driverText(r)}</span>
                      </>
                    ) : null}
                    {r.saps_case_number ? (
                      <>
                        {driverText(r) ? " · " : ""}
                        {t("incidents.sapsCase", locale).replace("{ref}", r.saps_case_number)}
                      </>
                    ) : null}
                    {r.third_party_name ? (
                      <> · {t("incidents.thirdParty", locale).replace("{name}", r.third_party_name)}</>
                    ) : null}
                  </p>

                  {r.injuries ? (
                    <p className="mt-1.5 rounded-lg border border-callout-danger-edge bg-callout-danger-bg px-3 py-1.5 text-sm font-medium text-callout-danger-ink">
                      {t("incidents.injuriesYes", locale)}
                      {r.injury_notes ? <span className="font-normal"> — {r.injury_notes}</span> : null}
                    </p>
                  ) : null}

                  {/* The claim line. A lodged claim says how many days it has been waiting,
                      because that is the sentence that gets somebody to ring the broker —
                      and it is the same figure the nightly reminder puts in its message. */}
                  {claimOpen(r.status) || r.status === "claim_settled" ? (
                    <p className="mt-1.5 text-sm text-sand-700">
                      {r.status === "claim_settled" && r.settled_incl_cents != null && r.settled_on
                        ? t("incidents.settledFor", locale)
                            .replace("{amount}", rands(r.settled_incl_cents))
                            .replace("{date}", shortDate(r.settled_on, locale))
                        : waiting != null
                          ? t("incidents.lodgedAgo", locale).replace("{n}", String(waiting))
                          : r.claim_lodged_on
                            ? t("incidents.lodgedOn", locale).replace(
                                "{date}",
                                shortDate(r.claim_lodged_on, locale),
                              )
                            : ""}
                      {r.claimed_incl_cents != null ? (
                        <span className="text-sand-500">
                          {" · "}
                          {t("incidents.claimed", locale).replace(
                            "{amount}",
                            rands(r.claimed_incl_cents),
                          )}
                        </span>
                      ) : null}
                      {r.excess_incl_cents != null ? (
                        <span className="text-sand-500">
                          {" · "}
                          {t("incidents.excess", locale).replace(
                            "{amount}",
                            rands(r.excess_incl_cents),
                          )}
                        </span>
                      ) : null}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {r.job_card_id ? (
                      <Link
                        href={`/jobcards/${r.job_card_id}`}
                        className={buttonVariants({ variant: "secondary", size: "sm" })}
                      >
                        {t("incidents.viewJobCard", locale)}
                      </Link>
                    ) : null}
                    {canManage ? (
                      <>
                        <Link
                          href={`/incidents?edit=${r.id}`}
                          className={buttonVariants({ variant: "secondary", size: "sm" })}
                        >
                          {t("incidents.update", locale)}
                        </Link>
                        <ConfirmDialog
                          triggerLabel={t("incidents.remove", locale)}
                          triggerVariant="ghost"
                          triggerSize="sm"
                          triggerIcon={<TrashIcon />}
                          title={t("incidents.removeTitle", locale)}
                          intro={t("incidents.removeBody", locale)}
                          confirmLabel={t("incidents.remove", locale)}
                          cancelLabel={t("incidents.removeNo", locale)}
                          action={removeIncident}
                        >
                          <input type="hidden" name="id" value={r.id} />
                        </ConfirmDialog>
                      </>
                    ) : null}
                  </div>

                  {/* The update form opens in place, on the row it is about. The vehicle
                      and the date are NOT in it: re-pointing an accident at a different
                      bakkie changes what the record says happened, on a row that may end
                      up in front of an insurer. */}
                  {canManage && editing && editing.id === r.id ? (
                    <form
                      action={updateIncident}
                      className="mt-3 grid gap-3 rounded-lg border border-sand-200 bg-sand-50 p-3 sm:grid-cols-2"
                    >
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="kind" value={r.kind} />
                      <div className="sm:col-span-2">
                        <CardTitle>{t("incidents.updateTitle", locale)}</CardTitle>
                      </div>
                      <Field label={t("incidents.fieldStatus", locale)} htmlFor={`st-${r.id}`}>
                        <Select id={`st-${r.id}`} name="status" defaultValue={r.status}>
                          {INCIDENT_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {t(incidentLook(s).labelKey, locale)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("incidents.fieldSaps", locale)} htmlFor={`saps-${r.id}`}>
                        <Input id={`saps-${r.id}`} name="saps_case_number" defaultValue={r.saps_case_number ?? ""} />
                      </Field>
                      {claimFields(r, `u${r.id.slice(0, 8)}`)}
                      <div className="sm:col-span-2">
                        <Field label={t("incidents.fieldClaimNotes", locale)} htmlFor={`cn-${r.id}`}>
                          <Input id={`cn-${r.id}`} name="claim_notes" defaultValue={r.claim_notes ?? ""} maxLength={300} />
                        </Field>
                      </div>
                      {/* Carried through so an update does not silently blank them. */}
                      <input type="hidden" name="location" value={r.location ?? ""} />
                      <input type="hidden" name="description" value={r.description ?? ""} />
                      <input type="hidden" name="driver_user_id" value={r.driver_user_id ?? ""} />
                      <input type="hidden" name="driver_name" value={r.driver_name ?? ""} />
                      <input type="hidden" name="saps_station" value={r.saps_station ?? ""} />
                      <input type="hidden" name="third_party_name" value={r.third_party_name ?? ""} />
                      <input type="hidden" name="third_party_contact" value={r.third_party_contact ?? ""} />
                      <input type="hidden" name="third_party_reg_no" value={r.third_party_reg_no ?? ""} />
                      <input type="hidden" name="third_party_insurer" value={r.third_party_insurer ?? ""} />
                      {r.injuries ? <input type="hidden" name="injuries" value="on" /> : null}
                      <input type="hidden" name="injury_notes" value={r.injury_notes ?? ""} />
                      <div className="sm:col-span-2">
                        <p className="mb-2 text-xs text-sand-500">{t("incidents.moneyNote", locale)}</p>
                        <SubmitButton variant="primary">{t("incidents.update", locale)}</SubmitButton>
                      </div>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {canManage ? (
        <details className="group rounded-2xl border border-sand-200 bg-surface shadow-xs">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:p-5">
            <span className="font-semibold text-ink">{t("incidents.addTitle", locale)}</span>
            <ChevronDownIcon className="shrink-0 text-sand-500 transition-transform group-open:rotate-180" />
          </summary>
          <form action={recordIncident} className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5 sm:pb-5">
            <Field label={t("incidents.fieldMachine", locale)} htmlFor="in-machine" required>
              <Select id="in-machine" name="machine_id" required defaultValue="">
                <option value="" disabled>
                  —
                </option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.reg_no ? `${m.name} · ${m.reg_no}` : m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("incidents.fieldKind", locale)} htmlFor="in-kind">
              <Select id="in-kind" name="kind" defaultValue="collision">
                {INCIDENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {enumLabel("incidentKind", k, locale)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("incidents.fieldWhen", locale)} htmlFor="in-when">
              <Input id="in-when" name="occurred_at" type="datetime-local" />
            </Field>
            <Field label={t("incidents.fieldWhere", locale)} htmlFor="in-where">
              <Input id="in-where" name="location" maxLength={120} />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t("incidents.fieldDescription", locale)} htmlFor="in-desc">
                <Input id="in-desc" name="description" maxLength={400} />
              </Field>
            </div>
            <Field label={t("incidents.fieldDriver", locale)} htmlFor="in-driver">
              <Select id="in-driver" name="driver_user_id" defaultValue="">
                <option value="">{t("incidents.fieldDriverNone", locale)}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("incidents.fieldDriverName", locale)} htmlFor="in-drivername">
              <Input id="in-drivername" name="driver_name" maxLength={80} />
            </Field>
            <Field label={t("incidents.fieldSaps", locale)} htmlFor="in-saps">
              <Input id="in-saps" name="saps_case_number" maxLength={40} />
            </Field>
            <Field label={t("incidents.fieldSapsStation", locale)} htmlFor="in-station">
              <Input id="in-station" name="saps_station" maxLength={60} />
            </Field>
            <Field label={t("incidents.fieldThirdParty", locale)} htmlFor="in-tp">
              <Input id="in-tp" name="third_party_name" maxLength={80} />
            </Field>
            <Field label={t("incidents.fieldThirdPartyContact", locale)} htmlFor="in-tpc">
              <Input id="in-tpc" name="third_party_contact" maxLength={40} />
            </Field>
            <Field label={t("incidents.fieldThirdPartyReg", locale)} htmlFor="in-tpr">
              <Input id="in-tpr" name="third_party_reg_no" maxLength={20} />
            </Field>
            <Field label={t("incidents.fieldThirdPartyInsurer", locale)} htmlFor="in-tpi">
              <Input id="in-tpi" name="third_party_insurer" maxLength={60} />
            </Field>
            <label className="flex items-start gap-3 sm:col-span-2">
              <input type="checkbox" name="injuries" className="mt-1 size-5" />
              <span className="text-sm text-sand-800">{t("incidents.fieldInjuries", locale)}</span>
            </label>
            <div className="sm:col-span-2">
              <Field label={t("incidents.fieldInjuryNotes", locale)} htmlFor="in-injnotes">
                <Input id="in-injnotes" name="injury_notes" maxLength={300} />
              </Field>
            </div>
            <Field label={t("incidents.fieldStatus", locale)} htmlFor="in-status">
              <Select id="in-status" name="status" defaultValue="reported">
                {INCIDENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(incidentLook(s).labelKey, locale)}
                  </option>
                ))}
              </Select>
            </Field>
            {claimFields(null, "in")}
            <div className="sm:col-span-2">
              <Field label={t("incidents.fieldClaimNotes", locale)} htmlFor="in-claimnotes">
                <Input id="in-claimnotes" name="claim_notes" maxLength={300} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <p className="mb-2 text-xs text-sand-500">{t("incidents.moneyNote", locale)}</p>
              <SubmitButton variant="primary">{t("incidents.add", locale)}</SubmitButton>
            </div>
          </form>
        </details>
      ) : null}
    </div>
  );
}
