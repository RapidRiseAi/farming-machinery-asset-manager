import { requireProfile } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageInfoButton } from "@/components/ui/page-info-button";
import { InstallApp } from "@/components/install-app";
import { CheckIcon, InfoIcon, FuelIcon } from "@/components/ui/icons";

/**
 * "Where do I download it?"
 *
 * FleetWise has worked offline since F2 — a service worker caches the shell and the
 * last views, and captures go into an IndexedDB queue that drains when the signal
 * returns — but there was no install affordance anywhere, so unless someone knew to
 * find it in a browser menu, the whole capability was invisible. Being told the app
 * works offline and then finding no way to install it reads as a broken promise.
 *
 * This page is deliberately honest that there is no file: it is a PWA, it installs
 * from here, and that is also why it is never out of date.
 */
export default async function InstallPage() {
  const profile = await requireProfile();
  const locale = profile.lang;

  const why = t("install.why", locale).split("\n").filter(Boolean);
  const offline = t("install.offline", locale).split("\n").filter(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.6rem] font-bold leading-tight tracking-tight text-sand-950">
            {t("install.title", locale)}
          </h1>
          <PageInfoButton infoKey="install" locale={locale} />
        </div>
        <p className="mt-1 text-sm text-sand-500">{t("install.subtitle", locale)}</p>
      </div>

      <Card>
        <InstallApp locale={locale} />
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("install.whyTitle", locale)}</CardTitle></CardHeader>
        <ul className="flex flex-col gap-2.5">
          {why.map((line) => (
            <li key={line} className="flex items-start gap-2.5 text-sm text-sand-700">
              <span className="mt-0.5 shrink-0 text-[1.05rem] text-brand-600"><CheckIcon /></span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("install.offlineTitle", locale)}</CardTitle></CardHeader>
        <ul className="flex flex-col gap-2.5">
          {offline.map((line) => (
            <li key={line} className="flex items-start gap-2.5 text-sm text-sand-700">
              <span className="mt-0.5 shrink-0 text-[1.05rem] text-brand-600"><FuelIcon /></span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2.5 text-sm text-sand-600">
          {t("install.offlineNote", locale)}
        </p>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("install.noFileTitle", locale)}</CardTitle></CardHeader>
        <p className="flex items-start gap-2.5 text-sm text-sand-700">
          <span className="mt-0.5 shrink-0 text-[1.05rem] text-sand-400"><InfoIcon /></span>
          <span>{t("install.noFile", locale)}</span>
        </p>
      </Card>
    </div>
  );
}
