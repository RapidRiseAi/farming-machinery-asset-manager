import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile, currentFarmId, checkEntitlement, homePathFor } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { relativeDate } from "@/lib/format";
import { signOut } from "../actions";
import { AllClear } from "@/components/ui/empty-state";
import { SubmitButton } from "@/components/ui/submit-button";
import { buttonVariants } from "@/components/ui/button";
import {
  MachinesIcon, FaultsIcon, FuelIcon, JobCardsIcon, SignOutIcon, ChevronRightIcon,
} from "@/components/ui/icons";

type MachineRow = {
  id: string;
  name: string;
  location: string | null;
  primary_attachment_id: string | null;
};

/**
 * The driver's own home.
 *
 * The least computer-literate role had no screen of its own — an operator saw the same
 * sidebar, the same bottom tabs and the same "More" sheet as the owner: a navigation
 * system built for fourteen destinations, handed to someone with four tasks. The QR
 * flow proves the right shape for this user (one big thing per screen, photos, no
 * jargon); this gives the signed-in driver the same treatment.
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
  // Everyone else belongs on their own home — never assume that is the dashboard.
  if (profile.role !== "operator") redirect(homePathFor(profile.role));

  const locale = profile.lang;
  const supabase = await createClient();
  const farmId = await currentFarmId(profile);

  let machinesQ = supabase
    .from("machines")
    .select("id, name, location, primary_attachment_id")
    .is("deleted_at", null)
    .not("status", "in", "(retired,sold)")
    .order("name");
  if (farmId) machinesQ = machinesQ.eq("farm_id", farmId);

  const [{ data: mData }, { data: fData }] = await Promise.all([
    machinesQ,
    // Their own reports, so the loop closes — a driver used to report a fault and never
    // hear anything again, so next time he tells the foreman and the system goes quiet.
    supabase
      .from("faults")
      .select("id, machine_id, status, description, created_at")
      .eq("reported_by", profile.id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const machines = (mData as MachineRow[] | null) ?? [];
  const myFaults =
    (fData as { id: string; machine_id: string; status: string; description: string | null; created_at: string }[] | null) ?? [];
  const nameById = new Map(machines.map((m) => [m.id, m.name]));
  const openMine = myFaults.filter((f) => f.status !== "resolved");
  const beingWorked = openMine.find((f) => f.status === "in_progress" || f.status === "in_job");

  // Photos, batch-signed the same way the machines list does it.
  const primaryIds = machines.map((m) => m.primary_attachment_id).filter((v): v is string => !!v);
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
      for (const m of machines) {
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
  const today = new Date().toLocaleDateString(locale === "af" ? "af-ZA" : "en-ZA", { weekday: "long" });

  const tiles = [
    { href: "/machines", icon: <MachinesIcon />, title: t("driver.tileScan", locale), hint: t("driver.tileScanHint", locale), loud: true },
    { href: "/faults", icon: <FaultsIcon />, title: t("driver.tileFault", locale), hint: t("driver.tileFaultHint", locale), loud: false },
    { href: "/machines", icon: <JobCardsIcon />, title: t("driver.tileHours", locale), hint: t("driver.tileHoursHint", locale), loud: false },
    ...(fuelAllowed
      ? [{ href: "/fuel", icon: <FuelIcon />, title: t("driver.tileFuel", locale), hint: t("driver.tileFuelHint", locale), loud: false }]
      : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      {/* `?error=forbidden` was never rendered as anything a person could read — the
          screen just changed. */}
      {sp.denied ? (
        <p className="rounded-xl border border-sand-200 bg-sand-100 p-3.5 text-sm text-sand-700" role="status">
          <span className="font-semibold text-sand-900">{t("ui.deniedTitle", locale)}</span>{" "}
          {t("ui.deniedBody", locale)}
        </p>
      ) : null}

      <header>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-sand-950">{greeting}</h1>
          <PageInfoButton infoKey="driver" locale={locale} />
        </div>
        <p className="mt-1 text-sand-500">
          <span className="capitalize">{today}</span>
        </p>
      </header>

      <section>
        <h2 className="text-[1.15rem] font-bold text-sand-900">{t("driver.whatDoYouWant", locale)}</h2>
        <ul className="mt-3 flex flex-col gap-2.5">
          {tiles.map((tile, i) => (
            <li key={`${tile.href}-${i}`}>
              <Link
                href={tile.href}
                className={`focus-ring flex w-full items-center gap-4 rounded-2xl border px-4 py-4 transition-colors ${
                  tile.loud
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-sand-200 bg-white hover:bg-sand-50"
                }`}
              >
                <span
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-[1.5rem] ${
                    tile.loud ? "bg-white/15 text-white" : "bg-brand-50 text-brand-700"
                  }`}
                  aria-hidden
                >
                  {tile.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[1.15rem] font-semibold leading-snug ${tile.loud ? "text-white" : "text-sand-900"}`}>
                    {tile.title}
                  </span>
                  <span className={`mt-0.5 block text-sm leading-snug ${tile.loud ? "text-white/80" : "text-sand-500"}`}>
                    {tile.hint}
                  </span>
                </span>
                <ChevronRightIcon className={`shrink-0 text-[1.3rem] ${tile.loud ? "text-white/70" : "text-sand-300"}`} />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Which machine — a two-column grid of photographs, most-used first. Every
          machine chooser in the app is a <Select> of names and serials; for a driver a
          picture is faster and needs no literacy at all. */}
      {machines.length > 0 ? (
        <section>
          <h2 className="text-[1.15rem] font-bold text-sand-900">{t("driver.whichMachine", locale)}</h2>
          <p className="mt-0.5 text-sm text-sand-500">{t("driver.whichMachineHint", locale)}</p>
          <ul className="mt-3 grid grid-cols-2 gap-3">
            {machines.slice(0, 6).map((m) => (
              <li key={m.id}>
                <Link href={`/machines/${m.id}`} className="focus-ring block overflow-hidden rounded-2xl border border-sand-200 bg-white">
                  <span className="block aspect-[4/3] w-full bg-sand-100">
                    {photoByMachine.get(m.id) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photoByMachine.get(m.id)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-sand-300" aria-hidden>
                        <MachinesIcon className="text-[2rem]" />
                      </span>
                    )}
                  </span>
                  <span className="block px-3 py-2.5">
                    <span className="block truncate font-semibold leading-snug text-sand-900">{m.name}</span>
                    {m.location ? <span className="block truncate text-sm text-sand-500">{m.location}</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {machines.length > 6 ? (
            <Link href="/machines" className={buttonVariants({ variant: "secondary", fullWidth: true, className: "mt-3" })}>
              {t("driver.showAll", locale).replace("{n}", String(machines.length))}
            </Link>
          ) : null}
        </section>
      ) : (
        <p className="rounded-xl border border-sand-200 bg-white p-4 text-sand-600">{t("driver.noMachines", locale)}</p>
      )}

      {/* Closing the loop. */}
      {openMine.length === 0 ? (
        <AllClear
          title={t("driver.seenTitle", locale)}
          hint={myFaults.length === 0 ? t("driver.nothingReported", locale) : t("driver.seenHint", locale)}
        />
      ) : (
        <section className="rounded-2xl border border-sand-200 bg-white p-4">
          <h2 className="font-semibold text-sand-900">
            {openMine.length === 1
              ? t("driver.oneWaitingTitle", locale)
              : t("driver.waitingTitle", locale).replace("{n}", String(openMine.length))}
          </h2>
          {beingWorked ? (
            <p className="mt-1 text-sm text-sand-600">
              {t("driver.beingWorkedOn", locale).replace("{machine}", nameById.get(beingWorked.machine_id) ?? "—")}
            </p>
          ) : null}
          <ul className="mt-3 flex flex-col divide-y divide-sand-100">
            {openMine.slice(0, 4).map((f) => (
              <li key={f.id} className="py-2.5">
                <p className="font-medium text-sand-900">{nameById.get(f.machine_id) ?? "—"}</p>
                <p className="truncate text-sm text-sand-500">
                  {f.description} · {relativeDate(f.created_at, locale)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* On a shared bakkie phone, signing out matters more than for anyone else — and
          it sat two taps deep inside the overflow menu. */}
      <form action={signOut} className="pb-4">
        <SubmitButton variant="secondary" size="lg" fullWidth leftIcon={<SignOutIcon />}>
          {t("driver.signOut", locale)}
        </SubmitButton>
      </form>
    </div>
  );
}
