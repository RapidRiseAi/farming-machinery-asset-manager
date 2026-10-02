"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { WarningIcon } from "@/components/ui/icons";
import { reportClientError } from "@/lib/client-report";
import { t, locales, defaultLocale, type Locale } from "@/lib/i18n";

/**
 * What a signed-in page shows when it throws.
 *
 * There was no error boundary anywhere in the app, so a failed query rendered Next's
 * default, a blank screen with a technical string on it. On a farm that is
 * indistinguishable from "the app is broken", and the only recovery anyone would find
 * is closing the tab.
 *
 * Deliberately plain-language, and offers the two things that actually help: try again
 * (most failures here are a dropped connection mid-query) and a way back to somewhere
 * that works. `digest` is shown small because it is the only handle support has.
 *
 * The words go through t(). This boundary is a client component with no profile in reach,
 * so the language comes from `<html lang>`, which the root layout sets from the same
 * cookie a signed-in person's language choice writes. It is read after mount so the
 * first render matches whatever the server sent.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  useEffect(() => {
    const lang = document.documentElement.lang.slice(0, 2);
    if ((locales as readonly string[]).includes(lang)) setLocale(lang as Locale);
  }, []);

  useEffect(() => {
    console.error(error);
    // Until now this screen was the end of the road: the farmer saw it and we never did.
    reportClientError(error, "app");
  }, [error]);

  return (
    // `data-error-boundary` is for the gates, not for the person reading this.
    // `scripts/ui_check.mjs` walks screens in a real browser and has to be able to tell
    // "this page rendered" from "this page fell into its error boundary". Without a
    // marker its only signal was the `<h1>`, and this boundary HAS an `<h1>`, so a
    // crashed `/machines/[id]` was reported as a healthy page with zero dialogs. The
    // alternative was matching the English sentence below, which would quietly stop
    // working the day it is translated.
    <div data-error-boundary="app" className="mx-auto flex w-full max-w-lg flex-col gap-4 py-6">
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-2xl text-status-overdue">
            <WarningIcon />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-sand-950">{t("appError.title", locale)}</h1>
            <p className="mt-1 text-sm text-sand-600">{t("appError.body", locale)}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={() => reset()}>
            {t("offline.retry", locale)}
          </Button>
          <Link href="/home" className={buttonVariants({ variant: "secondary" })}>
            {t("appError.home", locale)}
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-4 border-t border-sand-100 pt-3 text-xs text-sand-400">
            {t("appError.reference", locale)} <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
      </Card>
    </div>
  );
}
