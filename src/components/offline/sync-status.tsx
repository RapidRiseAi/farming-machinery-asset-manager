"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { isOnline, pendingCount, subscribe } from "@/lib/offline/capture";
import { flush } from "@/lib/offline/sync";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
import { cn } from "@/components/ui/cn";

type Mode = "online" | "offline" | "syncing" | "pending";

/**
 * Shell sync status. Quiet when everything is fine, loud only when it has news.
 *
 * It used to be a 48px green "Online" pill on every screen, plus a "(3)" that repeated
 * the count already in the label, plus a separate 32px "Review saved captures" link in
 * the header row. On a 360px phone in Afrikaans ("Aanlyn", "Hersien gestoorde
 * inskrywings") that alone pushed the header past the viewport and Chrome zoomed every
 * page out.
 *
 *  - Online, nothing waiting: a small green dot. The word is still announced through
 *    the status region, it just takes no width.
 *  - Offline, syncing or waiting: ONE pill with a word and at most one count. Tapping it
 *    opens a menu titled "Saved on this phone" with "Sync now" (disabled while offline)
 *    and the review screen. The pill's label truncates rather than widening the header.
 *
 * After a flush that applied anything, the current route is refreshed so dependent
 * metrics (service due, spend) recompute.
 */
export function SyncStatus({ locale }: { locale: Lang }) {
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
  const waiting = t("offline.toSync", locale).replace("{count}", String(count));
  const label =
    mode === "offline"
      ? count > 0
        ? `${t("offline.offline", locale)}, ${waiting}`
        : t("offline.offline", locale)
      : mode === "syncing"
        ? t("offline.syncing", locale)
        : mode === "pending"
          ? waiting
          : t("offline.online", locale);
  // What the pill shows. Offline with captures waiting is "Offline · 3": the full
  // sentence is in the status region, the trigger's name and the menu.
  const short = mode === "offline" && count > 0 ? `${t("offline.offline", locale)} · ${count}` : label;

  // The status region is always there, so a screen reader hears every change of state,
  // including the return to "Online" that no longer has a visible word.
  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );

  if (mode === "online") {
    return (
      <>
        {status}
        <span
          aria-hidden
          title={label}
          className="inline-flex h-12 w-4 shrink-0 items-center justify-center sm:h-9"
        >
          <span className="h-2.5 w-2.5 rounded-full bg-status-ok" />
        </span>
      </>
    );
  }

  const tone: Record<Exclude<Mode, "online">, string> = {
    offline: "border-status-due/40 bg-callout-warn-bg text-status-due",
    syncing: "border-brand-200 bg-brand-tint text-brand-ink",
    pending: "border-status-due/40 bg-callout-warn-bg text-status-due",
  };
  const dot: Record<Exclude<Mode, "online">, string> = {
    offline: "bg-status-due",
    syncing: "bg-brand-500 animate-pulse",
    pending: "bg-status-due",
  };

  const canFlush = online && count > 0 && !syncing;

  return (
    <>
      {status}
      <ActionMenu
        title={t("offline.savedHere", locale)}
        label={label}
        closeLabel={t("ui.close", locale)}
        triggerLook="bare"
        triggerClassName={cn(
          "focus-ring inline-flex min-h-[48px] min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium sm:min-h-[36px]",
          tone[mode],
        )}
        trigger={
          <>
            <span className={cn("h-2 w-2 shrink-0 rounded-full", dot[mode])} aria-hidden />
            {/* Capped at 5rem so no language can widen the phone header (see the width
                budget in (app)/layout.tsx); the full label is the button's name. */}
            <span className="min-w-0 max-w-[5rem] truncate sm:max-w-none">{short}</span>
          </>
        }
      >
        {mode === "offline" ? (
          <p className="px-1 pb-1 text-sm text-sand-600">{t("offline.savedOffline", locale)}</p>
        ) : null}
        <button
          type="button"
          disabled={!canFlush}
          onClick={() => {
            void flush().catch(() => setSyncing(false));
          }}
          className={cn(menuItemClass(), "disabled:cursor-not-allowed disabled:opacity-50")}
        >
          {syncing ? t("offline.syncing", locale) : t("offline.syncNow", locale)}
        </button>
        <Link href="/queue" className={menuItemClass()}>
          {t("offline.review", locale)}
        </Link>
      </ActionMenu>
    </>
  );
}
