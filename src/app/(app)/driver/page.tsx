import Link from "next/link";
import { Photo } from "@/components/ui/photo";
import { redirect } from "next/navigation";
import { requireProfile, currentFarmId, effectiveFarmRole, checkEntitlement, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { meterReading, relativeDate } from "@/lib/format";
import { signOut } from "../actions";
import { AssistantSafeSignOutForm } from "@/components/assistant/sign-out-form";
import { AllClear } from "@/components/ui/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { DateText } from "@/components/ui/date-text";
import { FaultStatus } from "@/components/ui/status";
import { ReportFaultDialog } from "@/components/report-fault-dialog";
import {
  MachinesIcon, FaultsIcon, FuelIcon, JobCardsIcon, SignOutIcon, ChevronRightIcon, CheckIcon,
} from "@/components/ui/icons";

type MachineRow = {
  id: string;
  name: string;
  location: string | null;
  primary_attachment_id: string | null;
  meter_type: string | null;
  current_reading: number | null;
  current_reading_date: string | null;
};

type MyFault = {
  id: string;
  machine_id: string;
  status: string;
  description: string | null;
  created_at: string;
  resolved_at: string | null;
};

/** Machine cards shown on the home screen before "Show all". */
const CARD_LIMIT = 6;

/** "Today" reads wrong mid-sentence ("Fixed Today"); a date starts with a digit and is unchanged. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The driver's own home.
 *
 * The least computer-literate role had no screen of its own, an operator saw the same
 * sidebar, the same bottom tabs and the same "More" sheet as the owner: a navigation
 * system built for fourteen destinations, handed to someone with four tasks. The QR
 * flow proves the right shape for this user (one big thing per screen, photos, no
 * jargon); this gives the signed-in driver the same treatment.
 *
 * Machine first. Every task a driver has needs a machine, so the screen starts with
 * his machines and puts the tasks under each one: "Problem" opens the fault report
 * with that machine already filled in, the reading button goes to its meter form.
 * The old first tile said "Scan a machine" and could not scan anything (there is no
 * scanner in the app; it opened the machines list), so it is gone; with more machines
 * than fit, a truthful "Pick a machine" opens that list instead.
 *
 * No new tables, actions or policies. This is the existing `operator` role reading the
 * machines RLS already scopes to them (F7: an operator sees only machines assigned to
 * them), and the same fault / reading / fuel routes the QR pages post to.
 *
 * A denied operator now lands HERE rather than on the owner's money page: `requireRole`
 * resolves each role's own home (`homePathFor`) and flags the bounce with `?denied=1`,
 * which this screen renders as a sentence instead of leaving the screen to change
 * silently.
 */
export default async function DriverHomePage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const sp = await searchParams;
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  const role = farmId ? await effectiveFarmRole(farmId, profile) : null;
  // A multi-site person's selected-farm membership is authoritative. Someone can be an
  // owner at their primary farm and the operator on this one (or the reverse).
  if (role !== "operator") redirect(homePathFor(role ?? profile.role));

  const locale = profile.lang;
  const supabase = await createClient();

  let machinesQ = supabase
    .from("machines")
    .select("id, name, location, primary_attachment_id, meter_type, current_reading, current_reading_date")
    .is("deleted_at", null)
    .not("status", "in", "(retired,sold)")
    .order("name");
  if (farmId) machinesQ = machinesQ.eq("farm_id", farmId);

  const myReports = () =>
    supabase
      .from("faults")
      .select("id, machine_id, status, description, created_at, resolved_at")
      .eq("reported_by", profile.id)
      .is("deleted_at", null);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Their own reports, so the loop closes: a driver used to report a fault and never
  // hear anything again, so next time he told the foreman and the system went quiet.
  // Open ones say where they stand; ones fixed this week say so, with the day.
  const [{ data: mData }, { data: openData }, { data: fixedData }, { count: everCount }] = await Promise.all([
    machinesQ,
    myReports().neq("status", "resolved").order("created_at", { ascending: false }).limit(10),
    myReports().eq("status", "resolved").gte("resolved_at", weekAgo).order("resolved_at", { ascending: false }).limit(5),
    supabase.from("faults").select("id", { count: "exact", head: true }).eq("reported_by", profile.id).is("deleted_at", null),
  ]);

  const machines = (mData as MachineRow[] | null) ?? [];
  const openMine = (openData as MyFault[] | null) ?? [];
  const fixedMine = (fixedData as MyFault[] | null) ?? [];
  const hasReported = (everCount ?? 0) > 0 || openMine.length > 0 || fixedMine.length > 0;
  const nameById = new Map(machines.map((m) => [m.id, m.name]));
  const shown = machines.slice(0, CARD_LIMIT);
  const single = machines.length === 1;

  // Photos, batch-signed the same way the machines list does it.
  const primaryIds = shown.map((m) => m.primary_attachment_id).filter((v): v is string => !!v);
  const photoByMachine = new Map<string, string>();
  if (primaryIds.length > 0) {
    const { data: atts } = await supabase
      .from("attachments").select("id, storage_path").in("id", primaryIds).is("deleted_at", null);
    const pathById = new Map<string, string>();
    for (const a of (atts as { id: string; storage_path: string | null }[] | null) ?? []) {
      if (a.storage_path) pathById.set(a.id, a.storage_path);
    }
    const paths = [...new Set(pathById.values())];
    if (paths.length > 0) {
      const { data: signed } = await supabase.storage.from("machine-photos").createSignedUrls(paths, 3600);
      const urlByPath = new Map<string, string>();
      for (const sg of signed ?? []) if (sg.path && sg.signedUrl) urlByPath.set(sg.path, sg.signedUrl);
      for (const m of shown) {
        const p = m.primary_attachment_id ? pathById.get(m.primary_attachment_id) : undefined;
        const u = p ? urlByPath.get(p) : undefined;
        if (u) photoByMachine.set(m.id, u);
      }
    }
  }

  const fuelAllowed = (await checkEntitlement("fuel", profile)).allowed;

  const sastHour = new Date(Date.now() + 2 * 3_600_000).getUTCHours();
  const firstName = profile.name.trim().split(/\s+/)[0] || profile.name;
  const greeting = t(sastHour < 12 ? "driver.greeting" : "driver.greetingPm", locale).replace("{name}", firstName);

  // What is not tied to one card. "Pick a machine" and the general fault report only
  // earn a tile when some machines are not on screen as cards.
  const tiles = [
    ...(machines.length > CARD_LIMIT
      ? [
          { href: "/machines", icon: <MachinesIcon />, title: t("driver.tilePick", locale), hint: t("driver.tilePickHint", locale) },
          { href: "/faults?report=1", icon: <FaultsIcon />, title: t("driver.tileFault", locale), hint: t("driver.tileFaultHint", locale) },
        ]
      : []),
    ...(fuelAllowed
      ? [{ href: "/fuel", icon: <FuelIcon />, title: t("driver.tileFuel", locale), hint: t("driver.tileFuelHint", locale) }]
      : []),
  ];

  return (
    <PageContainer size="narrow">
      {/* `?error=forbidden` was never rendered as anything a person could read, the
          screen just changed. */}
      {sp.denied ? (
        <p className="rounded-xl border border-sand-200 bg-sand-100 p-3.5 text-sm text-sand-700" role="status">
          <span className="font-semibold text-sand-900">{t("ui.deniedTitle", locale)}</span>{" "}
          {t("ui.deniedBody", locale)}
        </p>
      ) : null}

      <PageHeader
        title={greeting}
        meta={<DateText value={new Date()} locale={locale} format="day" />}
        infoKey="driver"
        locale={locale}
      />

      <Link href="/driver/activity" className={buttonVariants({variant:"primary",size:"lg",fullWidth:true})}>{t("driving.title",locale)}</Link>
      {machines.length > 0 ? (
        <section id="assigned-machines" aria-labelledby="driver-machines" className="scroll-mt-24">
          <h2 id="driver-machines" className="text-lg font-bold text-sand-900">{t("driver.whichMachine", locale)}</h2>
          <p className="mt-0.5 text-sm text-sand-500">{t("driver.machinesHint", locale)}</p>
          <ul className="mt-3 flex flex-col gap-3">
            {shown.map((m) => {
              const metered = !!m.meter_type && m.meter_type !== "none";
              return (
                <li key={m.id} className="overflow-hidden rounded-2xl border border-sand-200 bg-surface">
                  {/* alt="" is right here: the machine's name is the next line of the
                      card, so describing the photo repeats it. */}
                  {single ? (
                    <Photo
                      src={photoByMachine.get(m.id)}
                      alt=""
                      size="card"
                      className="block aspect-[16/9] w-full"
                      placeholder={<MachinesIcon className="text-3xl" />}
                    />
                  ) : null}
                  <div className="flex items-center gap-3 p-3">
                    {!single ? (
                      <Photo
                        src={photoByMachine.get(m.id)}
                        alt=""
                        size="thumb"
                        className="h-16 w-20 shrink-0 rounded-xl"
                        placeholder={<MachinesIcon className="text-2xl" />}
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold leading-snug text-sand-900">{m.name}</p>
                      {m.location ? <p className="truncate text-sm text-sand-500">{m.location}</p> : null}
                      {metered && m.current_reading != null ? (
                        <p className="tnum text-sm text-sand-500">
                          {t("driver.lastReading", locale)
                            .replace("{reading}", meterReading(m.current_reading, m.meter_type, locale))
                            .replace("{when}", lowerFirst(relativeDate(m.current_reading_date, locale)))}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className={`grid gap-2 border-t border-sand-100 p-3 ${metered ? "grid-cols-2" : "grid-cols-1"}`}>
                    <ReportFaultDialog
                      machines={[{ id: m.id, name: m.name }]}
                      redirectTo="/driver"
                      locale={locale}
                      trigger={t("driver.actProblem", locale)}
                      triggerVariant="secondary"
                      triggerFullWidth
                      triggerIcon={<FaultsIcon />}
                    />
                    {metered ? (
                      <Link
                        href={`/machines/${m.id}#meter-reading`}
                        className={buttonVariants({ variant: "secondary", fullWidth: true, className: "gap-2" })}
                      >
                        <JobCardsIcon aria-hidden />
                        {m.meter_type === "km" ? t("driver.actKm", locale) : t("driver.actHours", locale)}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {machines.length > CARD_LIMIT ? (
            <Link href="/machines" className={buttonVariants({ variant: "secondary", fullWidth: true, className: "mt-3" })}>
              {t("driver.showAll", locale).replace("{n}", String(machines.length))}
            </Link>
          ) : null}
        </section>
      ) : (
        <p className="rounded-xl border border-sand-200 bg-surface p-4 text-sand-600">{t("driver.noMachines", locale)}</p>
      )}

      {tiles.length > 0 ? (
        <section aria-labelledby="driver-other">
          <h2 id="driver-other" className="text-lg font-bold text-sand-900">{t("driver.otherThings", locale)}</h2>
          <ul className="mt-3 flex flex-col gap-2.5">
            {tiles.map((tile) => (
              <li key={tile.href}>
                <Link
                  href={tile.href}
                  className="focus-ring flex w-full items-center gap-4 rounded-2xl border border-sand-200 bg-surface px-4 py-4 transition-colors hover:bg-sand-50"
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-2xl text-brand-ink" aria-hidden>
                    {tile.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-semibold leading-snug text-sand-900">{tile.title}</span>
                    <span className="mt-0.5 block text-sm leading-snug text-sand-500">{tile.hint}</span>
                  </span>
                  <ChevronRightIcon className="shrink-0 text-xl text-sand-400" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Closing the loop. */}
      {openMine.length > 0 ? (
        <section aria-labelledby="driver-waiting" className="rounded-2xl border border-sand-200 bg-surface p-4">
          <h2 id="driver-waiting" className="font-semibold text-sand-900">
            {openMine.length === 1
              ? t("driver.oneWaitingTitle", locale)
              : t("driver.waitingTitle", locale).replace("{n}", String(openMine.length))}
          </h2>
          <ul className="mt-2 flex flex-col divide-y divide-sand-100">
            {openMine.slice(0, 4).map((f) => (
              <li key={f.id}>
                <Link href={`/faults#fault-${f.id}`} className="focus-ring flex min-h-[48px] items-center gap-3 rounded py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-sand-900">{nameById.get(f.machine_id) ?? "-"}</span>
                    <span className="block truncate text-sm text-sand-500">
                      {f.description ? `${f.description} · ` : ""}{relativeDate(f.created_at, locale)}
                    </span>
                  </span>
                  <FaultStatus value={f.status} locale={locale} />
                  <ChevronRightIcon className="shrink-0 text-sand-400" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : hasReported ? (
        <AllClear title={t("driver.seenTitle", locale)} hint={t("driver.seenHint", locale)} />
      ) : (
        <p className="text-sm text-sand-500">{t("driver.nothingReported", locale)}</p>
      )}

      {fixedMine.length > 0 ? (
        <section aria-labelledby="driver-fixed" className="rounded-2xl border border-sand-200 bg-surface p-4">
          <h2 id="driver-fixed" className="font-semibold text-sand-900">{t("driver.fixedTitle", locale)}</h2>
          <ul className="mt-2 flex flex-col divide-y divide-sand-100">
            {fixedMine.map((f) => (
              <li key={f.id} className="flex items-start gap-3 py-2.5">
                <CheckIcon className="mt-1 shrink-0 text-status-ok" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sand-900">{nameById.get(f.machine_id) ?? "-"}</span>
                  <span className="block truncate text-sm text-sand-500">
                    {t("driver.fixedWhen", locale).replace("{when}", lowerFirst(relativeDate(f.resolved_at ?? f.created_at, locale)))}
                    {f.description ? ` · ${f.description}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* On a shared bakkie phone, signing out matters more than for anyone else, and
          it sat two taps deep inside the overflow menu. */}
      <AssistantSafeSignOutForm action={signOut} className="pb-4" locale={locale}>
        <SubmitButton variant="secondary" size="lg" fullWidth leftIcon={<SignOutIcon />}>
          {t("driver.signOut", locale)}
        </SubmitButton>
      </AssistantSafeSignOutForm>
    </PageContainer>
  );
}
