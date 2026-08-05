"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckIcon, InfoIcon } from "@/components/ui/icons";
import { t, type Lang } from "@/lib/i18n";

/**
 * `beforeinstallprompt` is not in the DOM lib — it is a Chromium extension to the spec,
 * and the only way to trigger an install from a button rather than a browser menu.
 */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Platform = "installable" | "installed" | "ios" | "other";

/**
 * The "download it" button.
 *
 * FleetWise already works offline — a service worker caches the shell and the last
 * views, and mutations go into an IndexedDB queue that drains when the signal comes
 * back — but nothing on any screen ever offered to install it, so that whole capability
 * was invisible unless you knew to dig through a browser menu.
 *
 * There is no .apk or .exe to download: this is a PWA, and installing it is what puts
 * an icon on the home screen and lets it open without a browser and without signal.
 * The copy says that plainly rather than implying a file.
 *
 * Three states, because the browsers genuinely differ:
 *   - Chromium (most Android phones): a real install button via `beforeinstallprompt`.
 *   - iOS Safari: no such API at all — the only route is Share → Add to Home Screen,
 *     so we say exactly that instead of showing a button that cannot work.
 *   - Already installed: say so, rather than offering it again.
 */
export function InstallApp({ locale }: { locale: Lang }) {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<Platform>("other");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"accepted" | "dismissed" | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS reports installation here and nowhere else.
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) {
      setPlatform("installed");
      return;
    }

    const ua = window.navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document);
    if (isIos) setPlatform("ios");

    function onPrompt(e: Event) {
      // Stop Chrome's own mini-infobar so the offer appears where we explain it.
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
      setPlatform("installable");
    }
    function onInstalled() {
      setPlatform("installed");
      setDeferred(null);
    }

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!deferred) return;
    setBusy(true);
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      setOutcome(choice.outcome);
      if (choice.outcome === "accepted") setPlatform("installed");
      setDeferred(null);
    } finally {
      setBusy(false);
    }
  }

  if (platform === "installed") {
    return (
      <p className="inline-flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-800">
        <CheckIcon className="text-[1.1rem]" />
        {t("install.alreadyInstalled", locale)}
      </p>
    );
  }

  if (platform === "installable" && deferred) {
    return (
      <div className="flex flex-col gap-2">
        <Button type="button" variant="primary" size="lg" onClick={install} disabled={busy}>
          {busy ? t("install.working", locale) : t("install.button", locale)}
        </Button>
        {outcome === "dismissed" ? (
          <p className="text-sm text-sand-500">{t("install.dismissed", locale)}</p>
        ) : null}
      </div>
    );
  }

  // iOS, or a browser that has not offered the prompt (already dismissed, or unsupported).
  const steps =
    platform === "ios"
      ? t("install.iosSteps", locale).split("\n").filter(Boolean)
      : t("install.otherSteps", locale).split("\n").filter(Boolean);

  return (
    <div className="rounded-xl border border-sand-200 bg-sand-50 p-3.5">
      <p className="flex items-center gap-2 text-sm font-semibold text-sand-800">
        <InfoIcon className="text-[1.1rem] text-sand-500" />
        {platform === "ios" ? t("install.iosTitle", locale) : t("install.otherTitle", locale)}
      </p>
      <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-sand-700">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
