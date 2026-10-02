import { requireProfile } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { PageContainer, PageHeader } from "@/components/ui/page-header";
import { InstallApp } from "@/components/install-app";
import { CheckIcon } from "@/components/ui/icons";

/**
 * "Where do I download it?"
 *
 * FleetWise has worked offline since F2, a service worker caches the shell and the
 * last views, and captures go into an IndexedDB queue that drains when the signal
 * returns, but there was no install affordance anywhere, so unless someone knew to
 * find it in a browser menu, the whole capability was invisible. Being told the app
 * works offline and then finding no way to install it reads as a broken promise.
 *
 * This page is deliberately honest that there is no file: it is a PWA, it installs
 * from here, and that is also why it is never out of date.
 *
 * The install card and "Why bother" are what a person came for; what works offline and
 * why there is no file are reading for the curious, so they fold away rather than making
 * a 1,400px phone page out of three cards.
 */
export default async function InstallPage() {
  const profile = await requireProfile();
  const locale = profile.lang;

  const why = t("install.why", locale).split("\n").filter(Boolean);
  const offline = t("install.offline", locale).split("\n").filter(Boolean);

  const ticks = (lines: string[]) => (
    <ul className="flex flex-col gap-2.5">
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2.5 text-sm text-sand-700">
          <span className="mt-0.5 shrink-0 text-base text-brand-ink"><CheckIcon /></span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <PageContainer size="narrow">
      <PageHeader
        // "This phone" is right on a phone and odd on a laptop, so from sm up the
        // heading is the device-neutral name of the action.
        title={
          <>
            <span className="sm:hidden">{t("install.title", locale)}</span>
            <span className="hidden sm:inline">{t("install.button", locale)}</span>
          </>
        }
        lead={t("install.subtitle", locale)}
        infoKey="install"
        locale={locale}
      />

      <Card>
        <InstallApp locale={locale} />
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("install.whyTitle", locale)}</CardTitle></CardHeader>
        {ticks(why)}
      </Card>

      <Disclosure summary={t("install.offlineTitle", locale)}>
        {ticks(offline)}
        <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2.5 text-sm text-sand-600">
          {t("install.offlineNote", locale)}
        </p>
      </Disclosure>

      <Disclosure summary={t("install.noFileTitle", locale)}>
        <p className="text-sm leading-relaxed text-sand-700">{t("install.noFile", locale)}</p>
      </Disclosure>
    </PageContainer>
  );
}
