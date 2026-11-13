import type { Metadata } from "next";

import { verifyUnsubscribe } from "@/lib/email/unsubscribe";
import { errorMessage } from "@/lib/errors";
import { t, type Lang } from "@/lib/i18n";
import { deviceLocale, isLocale } from "@/lib/locale";
import { soft } from "@/lib/supabase/must";
import { createServiceClient } from "@/lib/supabase/service";
import { PublicShell } from "@/components/public-shell";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";
import { Flash } from "@/components/ui/flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { confirmUnsubscribe } from "./actions";

/**
 * Where "Turn these emails off" in an alert email lands. Opening it changes nothing, because
 * mail scanners open every link they see: the person presses the button. No sign-in, the
 * signed link is the authority (lib/email/unsubscribe.ts), and a link that does not check
 * out gets a neutral page that names nobody. Mail apps that offer their own unsubscribe
 * button post to /unsubscribe/one-click instead.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Alert emails",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string; s?: string; done?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const valid = verifyUnsubscribe(sp.u, sp.s);

  // The person's own language when the link is theirs, the device's otherwise. A failed read
  // only costs the language, so it is reported and the device's is used.
  let locale: Lang = await deviceLocale();
  if (valid) {
    const row = soft(
      await createServiceClient().from("users").select("language").eq("id", String(sp.u).toLowerCase()).maybeSingle(),
      "unsubscribe:language",
    ) as { language?: string } | null;
    if (isLocale(row?.language)) locale = row.language;
  }

  const heading = "text-2xl font-bold tracking-tight text-ink";
  const done = valid && sp.done === "1";
  // Shape and word as well as colour: a tick once it is done, a warning for a link that did
  // not check out, nothing while the person is still deciding.
  const mark = (good: boolean) => (
    <span
      className={`mb-4 flex size-10 items-center justify-center rounded-full text-xl ${
        good ? "bg-brand-tint text-status-ok" : "bg-callout-warn-bg text-status-due"
      }`}
      aria-hidden="true"
    >
      {good ? <CheckIcon /> : <WarningIcon />}
    </span>
  );

  return (
    <PublicShell locale={locale} languageSwitch={false}>
      <div className="pt-4 sm:pt-10">
        <div className="rounded-2xl border border-sand-200 bg-surface p-6 shadow-xs">
          {!valid ? (
            <>
              {mark(false)}
              <h1 className={heading}>{t("unsubscribe.invalidTitle", locale)}</h1>
              <p className="mt-2 text-sand-700">{t("unsubscribe.invalidBody", locale)}</p>
            </>
          ) : done ? (
            <>
              {mark(true)}
              <h1 className={heading}>{t("unsubscribe.doneTitle", locale)}</h1>
              <p className="mt-2 text-sand-700">{t("unsubscribe.doneBody", locale)}</p>
            </>
          ) : (
            <>
              <h1 className={heading}>{t("unsubscribe.title", locale)}</h1>
              <p className="mt-2 text-sand-700">{t("unsubscribe.body", locale)}</p>
              <Flash tone="error" message={errorMessage(sp.error, locale)} className="mt-5" />
              <form action={confirmUnsubscribe} className="mt-6">
                <input type="hidden" name="u" value={sp.u} />
                <input type="hidden" name="s" value={sp.s} />
                <SubmitButton size="lg" fullWidth pendingText={t("unsubscribe.pending", locale)}>
                  {t("unsubscribe.button", locale)}
                </SubmitButton>
              </form>
            </>
          )}
        </div>
      </div>
    </PublicShell>
  );
}
