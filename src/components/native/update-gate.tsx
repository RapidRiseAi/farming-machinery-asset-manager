"use client";

import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { onAppReturn } from "@/lib/app-return";
import { defaultLocale, locales, t, type Locale } from "@/lib/i18n";
import { updateNeed, type UpdatePolicy } from "@/lib/native/app-version";
import { nativePlatform } from "@/lib/native/platform";
import { fetchVersionInfo } from "@/lib/version-check";

/**
 * Asks the person to update the Android app, or makes them (28 Nov 2026; versions at
 * /admin/app-version, rules in lib/native/app-version.ts). Mounted once in the root layout, so
 * the sign-in screen has it too; nothing in a browser.
 *
 *   optional  a newer app is out. A screen over the app with "Update now" and "Not now". "Not
 *             now" lasts until the app is next opened: closed and started again, or back in
 *             front after REOPEN_AFTER_MS away. Then it asks again.
 *   required  this app is older than the oldest one allowed. The same screen with no "Not now",
 *             over everything, every time, until the app is updated.
 *
 * It asks only when the site answered: with no signal nobody is asked or blocked (and it checks
 * again when the signal is back). A phone whose version cannot be read is never blocked.
 * Recording a drive runs in Android's own service, so this screen never stops one.
 *
 * Every app ever built has @capacitor/app, so this works on the oldest one too.
 */

/** Away this long, coming back counts as opening the app again. */
const REOPEN_AFTER_MS = 15 * 60 * 1000;
const DISMISSED_KEY = "fleetwise:app-update-dismissed";

type Showing = { need: "optional" | "required"; installed: string; policy: UpdatePolicy };

function dismissedVersion(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function rememberDismissed(latest: string | null): void {
  try {
    if (latest) window.sessionStorage.setItem(DISMISSED_KEY, latest);
    else window.sessionStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* storage blocked: "Not now" then lasts until this page is next loaded */
  }
}

export function NativeUpdateGate() {
  const [showing, setShowing] = useState<Showing | null>(null);
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  // "Not now" in memory too, for a phone whose session storage is blocked.
  const dismissedRef = useRef<string | null>(null);
  const primaryRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (nativePlatform() !== "android") return;
    const lang = document.documentElement.lang.slice(0, 2);
    if ((locales as readonly string[]).includes(lang)) setLocale(lang as Locale);

    let installed: string | null = null;
    let cancelled = false;

    const check = async () => {
      if (installed === null) {
        try {
          const { App } = await import("@capacitor/app");
          installed = (await App.getInfo()).version;
        } catch {
          return; // the app cannot say which it is: never block it
        }
      }
      const info = await fetchVersionInfo();
      if (cancelled || !info?.android) return; // no answer (no signal): nobody is asked
      const need = updateNeed(installed, info.android);
      if (need === "none") {
        setShowing(null);
        return;
      }
      const dismissed = dismissedRef.current ?? dismissedVersion();
      if (need === "optional" && dismissed === info.android.latest) return;
      setShowing({ need, installed, policy: info.android });
    };

    void check();
    const offReturn = onAppReturn((awayMs) => {
      if (awayMs >= REOPEN_AFTER_MS) {
        dismissedRef.current = null;
        rememberDismissed(null);
      }
      void check();
    });
    const onOnline = () => void check();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      offReturn();
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (showing) primaryRef.current?.focus();
  }, [showing]);

  if (!showing) return null;
  const required = showing.need === "required";
  const fill = (key: string) =>
    t(key, locale).replace("{installed}", showing.installed).replace("{latest}", showing.policy.latest);

  const notNow = () => {
    dismissedRef.current = showing.policy.latest;
    rememberDismissed(showing.policy.latest);
    setShowing(null);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="fw-app-update-title"
      aria-describedby="fw-app-update-body"
      data-app-update={showing.need}
      // Over everything, the status-bar strip included. Required hides the app behind it
      // completely; optional dims it. Either way nothing behind can be tapped.
      className={
        "fixed inset-0 z-[200] flex touch-none items-end justify-center overscroll-contain pt-safe sm:items-center sm:p-4 " +
        (required ? "bg-surface-raised" : "bg-sand-950/50")
      }
    >
      <div className="w-full max-w-md touch-auto rounded-t-2xl bg-surface p-5 pb-[calc(var(--safe-bottom)+1.25rem)] shadow-pop sm:rounded-2xl sm:pb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-ink">FLEETWISE</p>
        <h2 id="fw-app-update-title" className="mt-1 text-lg font-bold text-ink">
          {fill(required ? "appUpdate.requiredTitle" : "appUpdate.title")}
        </h2>
        <p id="fw-app-update-body" className="mt-2 text-sm text-ink-muted">
          {fill(required ? "appUpdate.requiredBody" : "appUpdate.body")}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          {/* A plain link: the app hands any address that is not its own to Android, which
              opens the Play Store or the browser's download. */}
          <a ref={primaryRef} href={showing.policy.url} rel="noopener" className={buttonVariants({ variant: "primary", fullWidth: true })}>
            {t("appUpdate.updateNow", locale)}
          </a>
          {required ? null : (
            <Button type="button" variant="secondary" fullWidth onClick={notNow}>
              {t("appUpdate.notNow", locale)}
            </Button>
          )}
        </div>
        <p className="mt-3 text-xs text-ink-muted">{t("appUpdate.afterUpdate", locale)}</p>
      </div>
    </div>
  );
}
