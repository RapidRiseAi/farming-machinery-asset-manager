import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/service";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { meterReading, relativeDate } from "@/lib/format";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";
import { FaultCapture } from "@/components/fault-capture";
import { OfflineForm } from "@/components/offline/offline-form";
import { FUEL_ACTIVITIES, activityLabel } from "@/lib/fuel";
import { isPlan, planAllows } from "@/lib/entitlements";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MachinesIcon, CheckIcon } from "@/components/ui/icons";
import { QrChooser, type QrTask } from "./qr-chooser";
import { submitReading, submitService, submitFuel } from "./actions";

// Ultra-light public page (Scope §4.2): no auth, minimal payload. Always dynamic.
export const dynamic = "force-dynamic";

async function getMachine(token: string) {
  try {
    const svc = createServiceClient();
    const { data } = await svc
      .from("machines")
      .select("id, name, meter_type, current_reading, current_reading_date, primary_attachment_id, farms(plan)")
      .eq("public_token", token)
      .is("deleted_at", null)
      .maybeSingle();
    return data as
      | {
          id: string;
          name: string;
          meter_type: string;
          current_reading: number | null;
          current_reading_date: string | null;
          primary_attachment_id: string | null;
          farms: { plan: string } | null;
        }
      | null;
  } catch {
    return null;
  }
}

/** The machine's own photo, signed through the same service client the page already
 *  uses — stickers get swapped between machines and codes get scanned from the wrong
 *  side of a shed, so showing what you scanned catches a wrong report in one second. */
async function getPhotoUrl(attachmentId: string | null): Promise<string | null> {
  if (!attachmentId) return null;
  try {
    const svc = createServiceClient();
    const { data: att } = await svc
      .from("attachments")
      .select("storage_path")
      .eq("id", attachmentId)
      .is("deleted_at", null)
      .maybeSingle();
    const path = (att as { storage_path: string | null } | null)?.storage_path;
    if (!path) return null;
    const { data: signed } = await svc.storage.from("machine-photos").createSignedUrl(path, 3600);
    return signed?.signedUrl ?? null;
  } catch {
    return null;
  }
}

export default async function PublicMachinePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const machine = await getMachine(token);
  // Nobody is signed in here, so there is no `users.language` to read — the device
  // decides (cookie → Accept-Language → English). Reads a cookie and a header only:
  // the zero-anon-DB property of this route is untouched. Audit bug 2.
  const locale = await deviceLocale();

  if (!machine) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col gap-4 p-6">
        <h1 className="text-lg font-bold text-sand-900">{t("qr.notFoundTitle", locale)}</h1>
        <p className="mt-1 text-sand-500">{t("qr.notFoundBody", locale)}</p>
        <DeviceLanguageSwitcher current={locale} label={t("auth.language", locale)} />
      </main>
    );
  }

  const photoUrl = await getPhotoUrl(machine.primary_attachment_id);

  // Only surface the fuel quick-action when the farm's plan unlocks fuel (the server
  // action enforces this too — this just hides the UI on under-plan farms).
  const machinePlan = machine.farms?.plan;
  const fuelAllowed = !!machinePlan && isPlan(machinePlan) && planAllows(machinePlan, "fuel");
  const metered = machine.meter_type !== "none";

  const lastReading =
    machine.current_reading != null
      ? `${meterReading(machine.current_reading, machine.meter_type, locale)}${
          machine.current_reading_date ? ` · ${relativeDate(machine.current_reading_date, locale)}` : ""
        }`
      : null;

  const tiles: { task: QrTask; title: string; hint: string }[] = [
    { task: "fault", title: t("qr.tileProblem", locale), hint: t("qr.tileProblemHint", locale) },
    ...(metered
      ? [
          {
            task: "reading" as QrTask,
            title: t("qr.tileHours", locale),
            hint: lastReading
              ? t("qr.tileHoursHint", locale).replace("{last}", lastReading)
              : t("qr.tileHoursNoneHint", locale),
          },
        ]
      : []),
    ...(fuelAllowed
      ? [{ task: "fuel" as QrTask, title: t("qr.tileFuel", locale), hint: t("qr.tileFuelHint", locale) }]
      : []),
    { task: "service", title: t("qr.tileService", locale), hint: t("qr.tileServiceHint", locale) },
  ];

  const unitHint = metered ? t(`format.unit.${machine.meter_type}`, locale) : undefined;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col gap-5 bg-sand-50 p-5">
      <header className="flex items-center justify-between gap-2.5">
        <span className="flex items-center gap-2.5">
          {/* The app's own icon, not a tractor emoji — that rendered differently on
              every Android in the district and was read aloud as "tractor". */}
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white" aria-hidden>
            <MachinesIcon />
          </span>
          <span className="text-sm font-semibold text-sand-500">{t("app.name", locale)}</span>
        </span>
        <DeviceLanguageSwitcher current={locale} label={t("auth.language", locale)} />
      </header>

      {sp.sent ? (
        <p className="flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50 p-3.5 text-sm font-medium text-brand-900" role="status">
          <CheckIcon className="mt-0.5 shrink-0 text-[1.2rem] text-brand-700" />
          {sp.sent === "service"
            ? t("qr.serviceSent", locale)
            : sp.sent === "fuel"
              ? t("qr.fuelSent", locale)
              : t("qr.sentThanks", locale)}
        </p>
      ) : null}

      {/* What you scanned — photo first, so a wrong sticker is caught immediately. */}
      <section className="flex items-center gap-3.5 rounded-2xl border border-sand-200 bg-white p-3.5 shadow-card">
        <div className="h-[88px] w-[88px] shrink-0 overflow-hidden rounded-xl bg-sand-100 ring-1 ring-sand-200">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-sand-300" aria-hidden>
              <MachinesIcon className="text-[2rem]" />
            </span>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
            {t("qr.thisIsMachine", locale)}
          </p>
          <h1 className="mt-0.5 text-[1.3rem] font-bold leading-tight text-sand-950">{machine.name}</h1>
        </div>
      </section>

      <QrChooser
        locale={locale}
        tiles={tiles}
        panels={{
          fault: (
            <FaultCapture
              endpoint="/api/public/fault"
              token={token}
              redirectTo={`/m/${token}?sent=1`}
              locale={locale}
              variant="public"
            />
          ),
          reading: metered ? (
            <OfflineForm action={submitReading} type="log_reading" scope="public" locale={locale} className="flex flex-col gap-4">
              <input type="hidden" name="token" value={token} />
              {/* Every field has a real label that stays put — there was not one
                  `<label>` on this page, and a placeholder disappears the moment you
                  start typing. */}
              <Field label={t("qr.newReadingLabel", locale)} htmlFor="qr-reading" hint={unitHint} required>
                <Input id="qr-reading" name="reading" type="number" inputMode="decimal" step="0.1" required />
              </Field>
              <Field label={t("qr.yourNameLabel", locale)} htmlFor="qr-reading-name" hint={t("qr.yourNameHint", locale)}>
                <Input id="qr-reading-name" name="name" autoComplete="name" />
              </Field>
              <button className="min-h-[52px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">
                {t("qr.logReading", locale)}
              </button>
            </OfflineForm>
          ) : null,
          fuel: fuelAllowed ? (
            <form action={submitFuel} className="flex flex-col gap-4">
              <input type="hidden" name="token" value={token} />
              <Field label={t("qr.fuelLitresLabel", locale)} htmlFor="qr-litres" required>
                <Input id="qr-litres" name="litres" type="number" inputMode="decimal" step="0.1" required />
              </Field>
              {metered ? (
                <Field label={t("qr.fuelReadingLabel", locale)} htmlFor="qr-fuel-reading" hint={unitHint}>
                  <Input id="qr-fuel-reading" name="reading" type="number" inputMode="decimal" step="0.1" />
                </Field>
              ) : null}
              <Field label={t("qr.fuelCostLabel", locale)} htmlFor="qr-cost" hint={t("qr.fuelCostHint", locale)}>
                <Input id="qr-cost" name="cost" inputMode="decimal" />
              </Field>
              <Field label={t("qr.fuelActivityLabel", locale)} htmlFor="qr-activity">
                <Select id="qr-activity" name="activity" defaultValue="">
                  <option value="">—</option>
                  {FUEL_ACTIVITIES.map((a) => (
                    <option key={a} value={a}>{activityLabel(a, locale)}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("qr.yourNameLabel", locale)} htmlFor="qr-fuel-name" hint={t("qr.yourNameHint", locale)}>
                <Input id="qr-fuel-name" name="name" autoComplete="name" />
              </Field>
              <button className="min-h-[52px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">
                {t("qr.logFuelBtn", locale)}
              </button>
            </form>
          ) : null,
          service: (
            <form action={submitService} className="flex flex-col gap-4">
              <input type="hidden" name="token" value={token} />
              <Field label={t("qr.serviceNoteLabel", locale)} htmlFor="qr-note" required>
                <Textarea id="qr-note" name="note" rows={3} required />
              </Field>
              {metered ? (
                <Field label={t("qr.serviceReadingLabel", locale)} htmlFor="qr-svc-reading" hint={unitHint}>
                  <Input id="qr-svc-reading" name="reading" type="number" inputMode="decimal" step="0.1" />
                </Field>
              ) : null}
              <Field label={t("qr.yourNameLabel", locale)} htmlFor="qr-svc-name" hint={t("qr.yourNameHint", locale)}>
                <Input id="qr-svc-name" name="name" autoComplete="name" />
              </Field>
              <button className="min-h-[52px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">
                {t("qr.logServiceBtn", locale)}
              </button>
            </form>
          ),
        }}
      />

      <Link href="/login" className="pb-6 text-center text-sm font-medium text-sand-500">
        {t("qr.workHere", locale)}
      </Link>
    </main>
  );
}
