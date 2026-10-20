"use client";

import { startTransition, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { WarningIcon } from "@/components/ui/icons";
import { reportClientError } from "@/lib/client-report";
import { isConnectionFailure } from "@/lib/single-flight";
import { t, locales, defaultLocale, type Locale } from "@/lib/i18n";

/**
 * What a page shows when it throws, for every area of the product: the signed-in app, the
 * public pages (the QR sticker, the emailed invoice) and the sign-in screens. Only the app
 * had one; the others fell through to the root fallback, an English-only "the app did not
 * start" even for an Afrikaans driver on a page that had started fine.
 *
 * Plain language, and the two things that help: try again, and a way back. "Try again"
 * asks the server for the page afresh first: `reset()` alone re-rendered the data the page
 * already had, so a failed load usually came straight back. A form whose post never got an
 * answer lands here too (React sends a rejected action to the nearest boundary); that is
 * said plainly, the save may or may not have landed, check before entering it again.
 *
 * The words go through t(); with no profile in reach, the language comes from `<html lang>`
 * (the root layout sets it from the same cookie a person's language choice writes), read
 * after mount so the first render matches the server's.
 */
export function ErrorScreen({
  error,
  reset,
  area,
  homeHref,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Names the area in reports and in `data-error-boundary` (the browser checks read it). */
  area: "app" | "public" | "auth";
  /** Where "back" goes; none for a public page, which has no home to offer a stranger. */
  homeHref: string | null;
}) {
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [connection, setConnection] = useState(false);

  useEffect(() => {
    const lang = document.documentElement.lang.slice(0, 2);
    if ((locales as readonly string[]).includes(lang)) setLocale(lang as Locale);
  }, []);

  useEffect(() => {
    setConnection(isConnectionFailure(error, navigator.onLine !== false));
    console.error(error);
    reportClientError(error, area);
  }, [error, area]);

  const retry = () => {
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  return (
    // `data-error-boundary` is for the gates (ui_check, spam_check), not for the person.
    <div data-error-boundary={area} className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-6">
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-2xl text-status-overdue">
            <WarningIcon />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-sand-950">
              {t(connection ? "appError.connectionTitle" : "appError.title", locale)}
            </h1>
            <p className="mt-1 text-sm text-sand-600">
              {t(connection ? "appError.connectionBody" : "appError.body", locale)}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {connection ? (
            // A fresh load shows whether the save landed; re-rendering the same tree
            // would not.
            <Button type="button" variant="primary" onClick={() => window.location.reload()}>
              {t("appError.checkPage", locale)}
            </Button>
          ) : (
            <Button type="button" variant="primary" onClick={retry}>
              {t("offline.retry", locale)}
            </Button>
          )}
          {homeHref ? (
            <Link href={homeHref} className={buttonVariants({ variant: "secondary" })}>
              {t("appError.home", locale)}
            </Link>
          ) : null}
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
