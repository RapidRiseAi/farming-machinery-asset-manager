import Link from "next/link";
import { Photo } from "@/components/ui/photo";
import { createServiceClient } from "@/lib/supabase/service";
import { t } from "@/lib/i18n";
import { deviceLocale } from "@/lib/locale";
import { APP_NAME } from "@/lib/env";
import { meterReading, relativeDate } from "@/lib/format";
import { DeviceLanguageSwitcher } from "@/components/ui/device-language-switcher";
import { FaultCapture } from "@/components/fault-capture";
import { OfflineForm } from "@/components/offline/offline-form";
import { FUEL_ACTIVITIES, activityLabel } from "@/lib/fuel";
import { isPlan, planAllows } from "@/lib/entitlements";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { MachinesIcon, CheckIcon, WarningIcon } from "@/components/ui/icons";
import { QrChooser, type QrTask } from "./qr-chooser";
import { submitReading, submitFuel } from "./actions";

// Ultra-light public page (Scope §4.2): no auth, minimal payload. Always dynamic.
export const dynamic = "force-dynamic";

type PublicMachine = {
  id: string;
  name: string;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
  primary_attachment_id: string | null;
  farms: { plan: string } | null;
};

/**
 * Three outcomes, kept apart on purpose: a token we do not know is a different
 * message from a lookup that could not run, and a driver in a field deserves to
 * be told which — "ask the office for a new sticker" is wrong advice when the
 * database simply blinked.
 *
 * Each status is its OWN member rather than `"not_found" | "unavailable"` on one,
 * so TypeScript narrows to `found` after the two early returns.
 */
type MachineLookup =
  | { status: "found"; machine: PublicMachine }
  | { status: "not_found" }
  | { status: "unavailable" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QR_ERROR_KEYS: Record<string, string> = {
  invalid_reading: "qr.errorInvalidReading",
  reading_backwards: "qr.errorReadingBackwards",
  invalid_fuel: "qr.errorInvalidFuel",
  upgrade: "qr.errorUpgrade",
  rate_limited: "qr.errorRateLimited",
  not_found: "qr.notFoundBody",
  unavailable: "qr.errorUnavailable",
  "1": "qr.errorUnavailable",
};

async function getMachine(token: string): Promise<MachineLookup> {
  if (!UUID_PATTERN.test(token)) return { status: "not_found" };
  try {
    const svc = createServiceClient();
    const { data, error } = await svc
      .from("machines")
      .select("id, name, meter_type, current_reading, current_reading_date, primary_attachment_id, farms!inner(plan, status, deleted_at)")
      .eq("public_token", token)
      .is("deleted_at", null)
      .in("farms.status", ["trial", "active"])
      .is("farms.deleted_at", null)
      .maybeSingle();
    if (error) {
      console.error("[public-qr] machine lookup failed", { code: error.code });
      return { status: "unavailable" };
    }
    if (!data) return { status: "not_found" };
    // PostgREST types a to-one embed as an ARRAY even though it returns a single
    // object at runtime, so normalise rather than casting the shape away — a
    // double cast here would hide it if the relation ever really did return many.
    const row = data as Record<string, unknown> & { farms?: unknown };
    const farms = Array.isArray(row.farms) ? (row.farms[0] ?? null) : (row.farms ?? null);
    return {
      status: "found",
      machine: { ...(row as object), farms } as PublicMachine,
    };
  } catch (error) {
    console.error("[public-qr] machine lookup was unavailable", {
      cause: error instanceof Error ? error.name : "unknown",
    });
    return { status: "unavailable" };
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
  const lookup = await getMachine(token);
  // Nobody is signed in here, so there is no `users.language` to read — the device
  // decides (cookie → Accept-Language → English). Reads a cookie and a header only:
  // the zero-anon-DB property of this route is untouched. Audit bug 2.
  const locale = await deviceLocale();

  if (lookup.status === "unavailable") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-6 p-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-3xl text-white shadow-soft">
          <MachinesIcon aria-hidden />
        </span>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-ink">{APP_NAME}</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink">{t("qr.unavailableTitle", locale)}</h1>
          <p className="text-base text-ink-muted">{t("qr.unavailableBody", locale)}</p>
        </div>
        <form action={`/m/${encodeURIComponent(token)}`} method="get" className="w-full">
          <button
            type="submit"
            className="focus-ring flex min-h-[48px] w-full items-center justify-center rounded-lg bg-brand-600 px-5 text-base font-semibold text-white transition-colors hover:bg-brand-700"
          >
            {t("qr.tryAgain", locale)}
          </button>
        </form>
        <DeviceLanguageSwitcher current={locale} label={t("auth.language", locale)} />
      </main>
    );
  }

  if (lookup.status === "not_found") {
    /*
      This is the one screen a farm worker with no login may ever see, and the
      product's shop window on every client farm. It used to be a heading, a
      sentence and a language toggle stretched across the full width — no logo,
      no product name, and no link anywhere, so a driver who scanned a damaged
      sticker reached an anonymous dead end and stopped.

      Still ZERO ANON DB: nothing below queries anything. The lookup already
      failed; this branch only renders words.
    */
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-6 p-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-3xl text-white shadow-soft">
          <MachinesIcon aria-hidden />
        </span>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-ink">{APP_NAME}</p>
          <h1 className="text-2xl font-bold tracking-tight text-ink">{t("qr.notFoundTitle", locale)}</h1>
          <p className="text-base text-ink-muted">{t("qr.notFoundBody", locale)}</p>
        </div>
        <Link
          href="/login"
          className="focus-ring flex min-h-[48px] w-full items-center justify-center rounded-lg border border-edge bg-surface px-5 text-base font-medium text-ink transition-colors hover:bg-surface-sunken"
        >
          {t("qr.notFoundSignIn", locale)}
        </Link>
        <DeviceLanguageSwitcher current={locale} label={t("auth.language", locale)} />
      </main>
    );
  }

  const machine = lookup.machine;

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
  ];

  const unitHint = metered ? t(`format.unit.${machine.meter_type}`, locale) : undefined;
  const actionError = sp.error ? t(QR_ERROR_KEYS[sp.error] ?? "qr.errorUnavailable", locale) : null;

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
        <p className="flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-tint p-3.5 text-sm font-medium text-brand-ink" role="status">
          <CheckIcon className="mt-0.5 shrink-0 text-lg text-brand-ink" />
          {sp.sent === "fuel" ? t("qr.fuelSent", locale) : t("qr.sentThanks", locale)}
        </p>
      ) : null}

      {actionError ? (
        <p
          className="flex items-start gap-2 rounded-xl border border-status-overdue/30 bg-callout-danger-bg p-3.5 text-sm font-medium text-status-overdue"
          role="alert"
        >
          <WarningIcon className="mt-0.5 shrink-0 text-lg" />
          {actionError}
        </p>
      ) : null}

      {/* What you scanned — photo first, so a wrong sticker is caught immediately. */}
      <section className="flex items-center gap-3.5 rounded-2xl border border-sand-200 bg-surface p-3.5 shadow-card">
        {/* Leads the page so a wrong sticker is caught instantly — eager for
            that reason. */}
        <Photo
          src={photoUrl}
          alt=""
          size="detail"
          priority
          className="h-[88px] w-[88px] shrink-0 rounded-xl ring-1 ring-sand-200"
          placeholder={<MachinesIcon className="text-3xl" />}
        />
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-sand-500">
            {t("qr.thisIsMachine", locale)}
          </p>
          <h1 className="mt-0.5 text-xl font-bold leading-tight text-sand-950">{machine.name}</h1>
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
                <Input
                  id="qr-reading"
                  name="reading"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="99999999999.9"
                  step="0.1"
                  required
                />
              </Field>
              <Field label={t("qr.yourNameLabel", locale)} htmlFor="qr-reading-name" hint={t("qr.yourNameHint", locale)}>
                <Input id="qr-reading-name" name="name" autoComplete="name" maxLength={200} />
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
                <Input
                  id="qr-litres"
                  name="litres"
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  max="99999999999.9"
                  step="0.1"
                  required
                />
              </Field>
              {metered ? (
                <Field label={t("qr.fuelReadingLabel", locale)} htmlFor="qr-fuel-reading" hint={unitHint}>
                  <Input
                    id="qr-fuel-reading"
                    name="reading"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="99999999999.9"
                    step="0.1"
                  />
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
                <Input id="qr-fuel-name" name="name" autoComplete="name" maxLength={200} />
              </Field>
              <button className="min-h-[52px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">
                {t("qr.logFuelBtn", locale)}
              </button>
            </form>
          ) : null,
        }}
      />

      <Link href="/login" className="pb-6 text-center text-sm font-medium text-sand-500">
        {t("qr.workHere", locale)}
      </Link>
    </main>
  );
}
