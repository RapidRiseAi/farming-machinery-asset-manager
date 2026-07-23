import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/service";
import { t, defaultLocale } from "@/lib/i18n";
import { FaultCapture } from "@/components/fault-capture";
import { OfflineForm } from "@/components/offline/offline-form";
import { FUEL_ACTIVITIES, activityLabel } from "@/lib/fuel";
import { submitReading, submitService, submitFuel } from "./actions";

// Ultra-light public page (Scope §4.2): no auth, minimal payload. Always dynamic.
export const dynamic = "force-dynamic";

async function getMachine(token: string) {
  try {
    const svc = createServiceClient();
    const { data } = await svc
      .from("machines")
      .select("id, name, meter_type")
      .eq("public_token", token)
      .is("deleted_at", null)
      .maybeSingle();
    return data as { id: string; name: string; meter_type: string } | null;
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
  const locale = defaultLocale;

  if (!machine) {
    return (
      <main className="mx-auto max-w-sm p-6">
        <h1 className="text-lg font-bold text-sand-900">Machine not found</h1>
        <p className="mt-1 text-sand-500">This code isn’t recognised.</p>
      </main>
    );
  }

  const input = "w-full rounded-lg border border-sand-300 px-3 py-2.5 text-base";
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col gap-4 bg-sand-50 p-5">
      <header className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">🚜</span>
        <span className="text-sm font-semibold text-sand-500">{t("app.name", locale)}</span>
      </header>
      <h1 className="text-2xl font-bold text-sand-900">{machine.name}</h1>
      <p className="-mt-2 text-sm text-sand-500">{t("qr.quickActions", locale)}</p>

      {sp.sent === "service" ? (
        <p className="rounded-lg bg-green-50 p-3 text-sm font-medium text-green-700">✓ {t("qr.serviceSent", locale)}</p>
      ) : sp.sent === "fuel" ? (
        <p className="rounded-lg bg-green-50 p-3 text-sm font-medium text-green-700">✓ {t("qr.fuelSent", locale)}</p>
      ) : sp.sent ? (
        <p className="rounded-lg bg-green-50 p-3 text-sm font-medium text-green-700">✓ {t("qr.scanCaption", locale)}</p>
      ) : null}

      <section className="rounded-2xl border border-sand-200 bg-white p-4 shadow-card">
        <h2 className="mb-3 text-lg font-semibold text-sand-900">{t("qr.reportProblem", locale)}</h2>
        <FaultCapture
          endpoint="/api/public/fault"
          token={token}
          redirectTo={`/m/${token}?sent=1`}
          locale={locale}
          variant="public"
        />
      </section>

      {machine.meter_type !== "none" ? (
        <section className="rounded-2xl border border-sand-200 bg-white p-4 shadow-card">
          <h2 className="mb-3 text-lg font-semibold text-sand-900">{t("qr.logReading", locale)} ({machine.meter_type})</h2>
          <OfflineForm action={submitReading} type="log_reading" scope="public" locale={locale} className="flex flex-col gap-2">
            <input type="hidden" name="token" value={token} />
            <input name="reading" type="number" inputMode="decimal" step="0.1" required placeholder={t("machine.newReading", locale)} className={input} />
            <input name="name" placeholder={`${t("faults.yourName", locale)} (${t("faults.optional", locale)})`} className={input} />
            <button className="min-h-[48px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">{t("qr.logReading", locale)}</button>
          </OfflineForm>
        </section>
      ) : null}

      {/* Log a service (token-gated, service-role — zero anon DB access) */}
      <section className="rounded-2xl border border-sand-200 bg-white p-4 shadow-card">
        <h2 className="text-lg font-semibold text-sand-900">{t("qr.logService", locale)}</h2>
        <p className="mb-3 text-sm text-sand-500">{t("qr.logServiceDesc", locale)}</p>
        <form action={submitService} className="flex flex-col gap-2">
          <input type="hidden" name="token" value={token} />
          <textarea name="note" rows={2} required placeholder={t("qr.serviceNote", locale)} className={input} />
          {machine.meter_type !== "none" ? (
            <input name="reading" type="number" inputMode="decimal" step="0.1" placeholder={`${t("qr.serviceReading", locale)} (${machine.meter_type})`} className={input} />
          ) : null}
          <input name="name" placeholder={`${t("qr.driver", locale)} (${t("faults.optional", locale)})`} className={input} />
          <button className="min-h-[48px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">{t("qr.logServiceBtn", locale)}</button>
        </form>
      </section>

      {/* Log fuel (token-gated, service-role — zero anon DB access) */}
      <section className="rounded-2xl border border-sand-200 bg-white p-4 shadow-card">
        <h2 className="text-lg font-semibold text-sand-900">⛽ {t("qr.logFuel", locale)}</h2>
        <p className="mb-3 text-sm text-sand-500">{t("qr.logFuelDesc", locale)}</p>
        <form action={submitFuel} className="flex flex-col gap-2">
          <input type="hidden" name="token" value={token} />
          <input name="litres" type="number" inputMode="decimal" step="0.1" required placeholder={t("qr.fuelLitres", locale)} className={input} />
          {machine.meter_type !== "none" ? (
            <input name="reading" type="number" inputMode="decimal" step="0.1" placeholder={`${t("qr.fuelReading", locale)} (${machine.meter_type})`} className={input} />
          ) : null}
          <input name="cost" inputMode="decimal" placeholder={`${t("qr.fuelCost", locale)} — R`} className={input} />
          <select name="activity" defaultValue="" className={input}>
            <option value="">{t("qr.fuelActivity", locale)}</option>
            {FUEL_ACTIVITIES.map((a) => (
              <option key={a} value={a}>{activityLabel(a, locale)}</option>
            ))}
          </select>
          <input name="name" placeholder={`${t("qr.driver", locale)} (${t("faults.optional", locale)})`} className={input} />
          <button className="min-h-[48px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white">{t("qr.logFuelBtn", locale)}</button>
        </form>
      </section>

      <Link href="/login" className="pb-6 text-center text-sm text-sand-500">
        {t("qr.viewFullHistory", locale)}
      </Link>
    </main>
  );
}
