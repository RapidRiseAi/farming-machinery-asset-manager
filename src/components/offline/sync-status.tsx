"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { t, type Locale } from "@/lib/i18n";
import { isOnline, pendingCount, subscribe } from "@/lib/offline/capture";
import { flush } from "@/lib/offline/sync";

type Mode = "online" | "offline" | "syncing" | "pending";

/**
 * Shell sync-status pill: online/offline, pending count, and "syncing…". Tapping it while
 * online with items queued forces a flush. After a flush that applied anything, the current
 * route is refreshed so dependent metrics (service-due, spend) recompute.
 */
export function SyncStatus({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [online, setOnline] = useState(true);
  const [count, setCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    setMounted(true);
    let active = true;
    const refresh = () => {
      void pendingCount().then((c) => {
        if (active) setCount(c);
      });
    };
    const setOn = () => setOnline(isOnline());
    const onSyncing = () => setSyncing(true);
    const onFlushed = (e: Event) => {
      setSyncing(false);
      refresh();
      const applied = (e as CustomEvent<{ applied: number }>).detail?.applied ?? 0;
      if (applied > 0) router.refresh();
    };

    refresh();
    setOn();
    const unsub = subscribe(refresh);
    window.addEventListener("online", setOn);
    window.addEventListener("offline", setOn);
    window.addEventListener("fleetwise:syncing", onSyncing);
    window.addEventListener("fleetwise:flushed", onFlushed as EventListener);
    return () => {
      active = false;
      unsub();
      window.removeEventListener("online", setOn);
      window.removeEventListener("offline", setOn);
      window.removeEventListener("fleetwise:syncing", onSyncing);
      window.removeEventListener("fleetwise:flushed", onFlushed as EventListener);
    };
  }, [router]);

  if (!mounted) return null;

  const mode: Mode = !online ? "offline" : syncing ? "syncing" : count > 0 ? "pending" : "online";
  const label =
    mode === "offline"
      ? t("offline.offline", locale)
      : mode === "syncing"
        ? t("offline.syncing", locale)
        : mode === "pending"
          ? `${count} ${t("offline.pending", locale)}`
          : t("offline.online", locale);

  const tone: Record<Mode, string> = {
    online: "border-status-ok/30 bg-status-ok/10 text-status-ok",
    offline: "border-status-due/40 bg-amber-50 text-status-due",
    syncing: "border-brand-200 bg-brand-50 text-brand-700",
    pending: "border-status-due/40 bg-amber-50 text-status-due",
  };
  const dot: Record<Mode, string> = {
    online: "bg-status-ok",
    offline: "bg-status-due",
    syncing: "bg-brand-500 animate-pulse",
    pending: "bg-status-due",
  };

  const canFlush = online && count > 0 && !syncing;

  return (
    <button
      type="button"
      onClick={canFlush ? () => void flush() : undefined}
      aria-live="polite"
      aria-label={label}
      title={label}
      className={`focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium ${tone[mode]} ${canFlush ? "cursor-pointer" : "cursor-default"}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot[mode]}`} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      {count > 0 ? <span className="sm:hidden">{count}</span> : null}
    </button>
  );
}
