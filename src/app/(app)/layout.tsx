import Link from "next/link";
import { currentPlan } from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { t } from "@/lib/i18n";
import { signOut } from "./actions";
// Direct module imports keep every (app) route's client bundle to just the nav
// interactivity — the barrel would pull the kit's full client chunk (see
// src/components/ui/README.md).
import { NavLink, MoreMenu, type NavItemData } from "@/components/ui/nav";
import { BellIcon, MachinesIcon, SignOutIcon } from "@/components/ui/icons";
import { SyncStatus } from "@/components/offline/sync-status";

/** Two-letter initials from a display name, for the avatar chip. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile, plan } = await currentPlan();
  const locale = profile.language;
  const isManagerPlus = profile.role === "owner" || profile.role === "manager";
  const isAdmin = profile.role === "rr_admin";
  // Parts catalogue & service kits (F9) — maintained by farm crew + RR admin (global lib).
  const canParts = ["owner", "manager", "mechanic", "rr_admin"].includes(profile.role);

  // Entitlement-aware nav (F5): hide surfaces the farm's plan does not unlock.
  // plan == null → rr_admin/workshop bypass (everything visible).
  const has = (f: Parameters<typeof planAllows>[1]) => plan == null || planAllows(plan, f);
  const dashAllowed = has("dashboard");
  const reportsAllowed = has("advanced_reports");
  const fuelAllowed = has("fuel");
  // Logo/home link must point somewhere the plan can actually open.
  const homeHref = dashAllowed ? "/dashboard" : "/machines";

  // Nav catalogue (translated once, reused across shells).
  const dashboard: NavItemData = { href: "/dashboard", label: t("nav.dashboard", locale), icon: "dashboard" };
  const machines: NavItemData = { href: "/machines", label: t("nav.machines", locale), icon: "machines" };
  const jobcards: NavItemData = { href: "/jobcards", label: t("nav.jobcards", locale), icon: "jobcards" };
  const faults: NavItemData = { href: "/faults", label: t("nav.faults", locale), icon: "faults" };
  const fuel: NavItemData = { href: "/fuel", label: t("nav.fuel", locale), icon: "fuel" };
  const parts: NavItemData = { href: "/parts", label: t("nav.parts", locale), icon: "parts" };
  const reports: NavItemData = { href: "/reports", label: t("nav.reports", locale), icon: "reports" };
  const alerts: NavItemData = { href: "/notifications", label: t("nav.notifications", locale), icon: "bell" };
  const team: NavItemData = { href: "/team", label: t("nav.team", locale), icon: "team" };
  const settings: NavItemData = { href: "/settings", label: t("nav.settings", locale), icon: "settings" };
  const admin: NavItemData = { href: "/admin/farms", label: t("nav.admin", locale), icon: "admin" };

  // Mobile: primary tabs + a "More" sheet holding the rest (gated items dropped).
  const tabItems: NavItemData[] = [...(dashAllowed ? [dashboard] : []), machines, jobcards, faults];
  const moreItems: NavItemData[] = [
    ...(fuelAllowed ? [fuel] : []),
    ...(canParts ? [parts] : []),
    ...(reportsAllowed ? [reports] : []),
    alerts,
    ...(isManagerPlus ? [team, settings] : []),
    ...(isAdmin ? [admin] : []),
  ];

  // Desktop: grouped sidebar sections (gated items dropped).
  const overviewItems: NavItemData[] = [
    ...(dashAllowed ? [dashboard] : []),
    ...(reportsAllowed ? [reports] : []),
  ];
  const groups: { key: string; label: string; items: NavItemData[] }[] = [
    ...(overviewItems.length ? [{ key: "overview", label: t("nav.groupOverview", locale), items: overviewItems }] : []),
    { key: "workshop", label: t("nav.groupWorkshop", locale), items: [machines, jobcards, faults, ...(fuelAllowed ? [fuel] : []), ...(canParts ? [parts] : [])] },
    {
      key: "farm",
      label: t("nav.groupFarm", locale),
      items: [alerts, ...(isManagerPlus ? [team, settings] : [])],
    },
    ...(isAdmin ? [{ key: "admin", label: t("nav.groupAdmin", locale), items: [admin] }] : []),
  ];

  const appName = t("app.name", locale);
  const signOutLabel = t("nav.signOut", locale);

  const brandMark = (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-[1.3rem] text-white shadow-xs">
      <MachinesIcon />
    </span>
  );

  const avatar = (
    <span
      className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700"
      title={profile.name}
      aria-label={profile.name}
    >
      {initials(profile.name)}
    </span>
  );

  const bellLink = (
    <Link
      href="/notifications"
      aria-label={t("nav.notifications", locale)}
      className="focus-ring flex h-11 w-11 items-center justify-center rounded-lg text-[1.4rem] text-sand-600 hover:bg-sand-100"
    >
      <BellIcon />
    </Link>
  );

  // Sign-out row for the "More" sheet (server action stays server-side).
  const signOutSlot = (
    <form action={signOut}>
      <button
        type="submit"
        className="focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-[0.95rem] font-medium text-sand-800 hover:bg-sand-100"
      >
        <SignOutIcon className="text-[1.35rem] text-sand-500" />
        {signOutLabel}
      </button>
    </form>
  );

  return (
    <div className="min-h-dvh">
      {/* ---- Desktop sidebar (>=1024px) ---- */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sand-200 bg-white lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-4">
          {brandMark}
          <span className="text-lg font-bold tracking-tight text-sand-900">{appName}</span>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
          {groups.map((g) => (
            <div key={g.key} className="space-y-1">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-sand-400">
                {g.label}
              </p>
              {g.items.map((item) => (
                <NavLink key={item.href} item={item} variant="sidebar" />
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-sand-200 p-3">
          <div className="mb-1 flex items-center gap-2.5 px-1">
            {avatar}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-sand-900">{profile.name}</span>
              <span className="block truncate text-xs capitalize text-sand-500">{profile.role}</span>
            </span>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="focus-ring flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-sand-600 hover:bg-sand-100 hover:text-sand-900"
            >
              <SignOutIcon className="text-[1.25rem]" />
              {signOutLabel}
            </button>
          </form>
        </div>
      </aside>

      {/* ---- Content column ---- */}
      <div className="flex min-h-dvh flex-col lg:pl-64">
        {/* Mobile header */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-sand-200 bg-white/95 px-4 py-2.5 backdrop-blur lg:hidden">
          <Link href={homeHref} className="focus-ring flex items-center gap-2 rounded-lg">
            {brandMark}
            <span className="text-lg font-bold tracking-tight text-sand-900">{appName}</span>
          </Link>
          <div className="flex items-center gap-1.5">
            <SyncStatus locale={locale} />
            {bellLink}
            {avatar}
          </div>
        </header>

        {/* Desktop slim top bar */}
        <header className="sticky top-0 z-20 hidden items-center justify-end gap-1.5 border-b border-sand-200 bg-white/90 px-6 py-2 backdrop-blur lg:flex">
          <SyncStatus locale={locale} />
          {bellLink}
          {avatar}
        </header>

        <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 pb-24 pt-5 sm:px-6 lg:px-8 lg:pb-10">
          {children}
        </main>
      </div>

      {/* ---- Mobile bottom tab bar ---- */}
      <nav
        aria-label={appName}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-sand-200 bg-white/95 pb-safe backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch gap-1 px-2">
          {tabItems.map((item) => (
            <NavLink key={item.href} item={item} variant="tab" />
          ))}
          <MoreMenu
            label={t("nav.more", locale)}
            title={t("nav.menu", locale)}
            closeLabel={t("ui.close", locale)}
            items={moreItems}
            signOutSlot={signOutSlot}
          />
        </div>
      </nav>
    </div>
  );
}
