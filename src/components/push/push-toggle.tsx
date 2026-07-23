"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";

/** VAPID public key → bytes for PushManager.subscribe(applicationServerKey). */
function urlBase64ToBytes(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

type State = "loading" | "unsupported" | "unconfigured" | "denied" | "off" | "on" | "busy";

/**
 * Enable/disable Web Push on THIS device (FR-14.1). Permission-gated: only prompts on an
 * explicit click. Registers the browser PushSubscription with the server; the per-user
 * `notify_push` toggle (separate, in the prefs form) decides whether we actually push.
 */
export function PushToggle({ locale }: { locale: Locale }) {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (!cancelled) setState("unsupported");
        return;
      }
      if (!vapidKey) {
        if (!cancelled) setState("unconfigured");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setState("denied");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setState(sub ? "on" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidKey]);

  async function enable() {
    setError(null);
    setState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      // Ensure the SW is registered (the app shell registers it in production only).
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(vapidKey as string),
      });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, ua: navigator.userAgent }),
      });
      if (!res.ok) throw new Error("subscribe failed");
      setState("on");
    } catch {
      setError(t("push.error", locale));
      setState("off");
    }
  }

  async function disable() {
    setError(null);
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
    } catch {
      setError(t("push.error", locale));
      setState("on");
    }
  }

  const box = "rounded-lg border border-sand-200 bg-sand-50 p-3 text-sm";
  if (state === "loading") return <div className={box}><span className="text-sand-400">{t("common.loading", locale)}</span></div>;
  if (state === "unsupported") return <div className={box}><span className="text-sand-500">{t("push.unsupported", locale)}</span></div>;
  if (state === "unconfigured") return <div className={box}><span className="text-sand-500">{t("push.unconfigured", locale)}</span></div>;
  if (state === "denied") return <div className={box}><span className="text-sand-500">{t("push.denied", locale)}</span></div>;

  const on = state === "on";
  return (
    <div className={box}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sand-800">{t("push.thisDevice", locale)}</p>
          <p className="text-xs text-sand-500">{on ? t("push.enabledHint", locale) : t("push.disabledHint", locale)}</p>
        </div>
        <button
          type="button"
          onClick={on ? disable : enable}
          disabled={state === "busy"}
          className="focus-ring rounded-lg border border-sand-300 bg-white px-3 py-1.5 text-sm font-medium text-sand-800 hover:bg-sand-50 disabled:opacity-60"
        >
          {state === "busy" ? t("common.loading", locale) : on ? t("push.disable", locale) : t("push.enable", locale)}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-status-overdue">{error}</p> : null}
    </div>
  );
}
