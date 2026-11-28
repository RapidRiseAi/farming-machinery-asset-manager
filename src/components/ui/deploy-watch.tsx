"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { onAppReturn } from "@/lib/app-return";
import { defaultLocale, locales, t, type Locale } from "@/lib/i18n";
import { fetchVersionInfo } from "@/lib/version-check";

/**
 * Keeps an open copy of FLEETWISE on the current release (28 Nov 2026). Mounted once in the
 * root layout with the deployment that served this page (lib/deployment.ts).
 *
 * Why: every release renames the site's form actions (Next.js 15 makes their ids new on each
 * build), so a page opened before a release and posted after it is refused with "Server Action
 * not found". The Android app and a farm-office tab stay open for days, which made that a real
 * way for an older copy to break. Moving to another screen is already safe: Next.js loads the
 * whole page afresh when it sees a newer release.
 *
 *   Coming back after RETURN_AFTER_MS away, with a newer release live and nothing typed on this
 *   screen and nothing saving, the page reloads itself: the person sees the new release, as on
 *   a fresh open.
 *   Otherwise (they are looking at it, or have typed something) it never reloads under them: a
 *   small bar says FLEETWISE was updated, with a Reload button for when they are ready.
 *
 * A failed check does nothing. Off outside Vercel (no deployment id).
 */

const RETURN_AFTER_MS = 60 * 1000;
const POLL_MS = 10 * 60 * 1000;

/** A save or download is out: a busy button (Button sets aria-busy while it works). */
function somethingSaving(): boolean {
  return !!document.querySelector('button[aria-busy="true"], a[aria-busy="true"]');
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function DeployWatch({ build }: { build: string }) {
  const [stale, setStale] = useState(false);
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const typed = useRef(false);
  const pathname = usePathname();

  // A new screen starts with nothing typed on it.
  useEffect(() => {
    typed.current = false;
  }, [pathname]);

  useEffect(() => {
    if (!build) return;
    const lang = document.documentElement.lang.slice(0, 2);
    if ((locales as readonly string[]).includes(lang)) setLocale(lang as Locale);

    const onInput = (e: Event) => {
      if (isEditable(e.target)) typed.current = true;
    };
    const onSubmit = () => {
      typed.current = false;
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("submit", onSubmit, true);

    let cancelled = false;
    const check = async (returned: boolean) => {
      const info = await fetchVersionInfo();
      if (cancelled || !info?.web || info.web === build) return;
      if (returned && !typed.current && !somethingSaving()) {
        window.location.reload();
        return;
      }
      setStale(true);
    };

    const offReturn = onAppReturn((awayMs) => {
      if (awayMs >= RETURN_AFTER_MS) void check(true);
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check(false);
    }, POLL_MS);
    const onOnline = () => void check(false);
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      offReturn();
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [build]);

  if (!stale) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 pb-safe lg:bottom-6" data-deploy-stale="">
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-edge-soft bg-surface px-4 py-3 shadow-pop"
      >
        <p className="min-w-0 flex-1 text-sm text-ink">
          <span className="font-semibold">{t("appUpdate.webTitle", locale)}</span>{" "}
          <span className="text-ink-muted">{t("appUpdate.webBody", locale)}</span>
        </p>
        <Button type="button" variant="primary" size="sm" onClick={() => window.location.reload()}>
          {t("appUpdate.reload", locale)}
        </Button>
      </div>
    </div>
  );
}
