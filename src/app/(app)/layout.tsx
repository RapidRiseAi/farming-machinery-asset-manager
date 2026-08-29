import Link from "next/link";
import {
  currentPlan,
  accessibleFarms,
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  supportFarm,
  checkWorkshopEntitlement,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { countInboxUnread } from "@/lib/inbox";
import { t } from "@/lib/i18n";
import { signOut } from "./actions";
import { AssistantSafeSignOutForm } from "@/components/assistant/sign-out-form";
// Direct module imports keep every (app) route's client bundle to just the nav
// interactivity — the barrel would pull the kit's full client chunk (see
// src/components/ui/README.md).
import { NavLink, MoreMenu, type NavItemData } from "@/components/ui/nav";
import { BellIcon, MachinesIcon, SignOutIcon, FaultsIcon } from "@/components/ui/icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WarmRoutes } from "@/components/offline/warm-routes";
import { SupportBanner } from "@/components/support-banner";
import { SiteSwitcher } from "@/components/ui/site-switcher";
import { LanguageSwitcher } from "@/components/ui/language-switcher";
import { SyncStatus } from "@/components/offline/sync-status";
import { Tour } from "@/components/tour";
import { tourFor } from "@/lib/tour";
import { farmPermissionState } from "@/lib/permissions";
import { assistantNavigationVisible } from "@/lib/assistant/navigation";

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
  const locale = profile.lang;
  // The EN/AF control shows the LANGUAGE choice, which is independent of tone — a
  // professional-tone Afrikaans user must still see AF selected, not "af-pro".
  const languageChoice = profile.language;
  const isManagerPlus = profile.role === "owner" || profile.role === "manager";
  const isAdmin = profile.role === "rr_admin";
  // Contractors (workshop role) get a tailored, contractor-first shell (F12c): their
  // aggregated dashboard is home, and farm-only surfaces are dropped.
  const isWorkshop = profile.role === "workshop";
  const isOperator = profile.role === "operator";
  // Parts catalogue & service kits (F9) — maintained by farm crew + RR admin (global lib).
  // Partners directory (F12a) — farmer-facing (browse/add/connect contractors) + RR admin
  // (curates the global suggested catalogue). Workshop users have their own views (F12c).
  const canPartners = profile.role !== "workshop";

  // Entitlement-aware nav (F5): hide surfaces the farm's plan does not unlock.
  // plan == null → rr_admin/workshop bypass (everything visible).
  const has = (f: Parameters<typeof planAllows>[1]) => plan == null || planAllows(plan, f);
  const dashAllowed = has("dashboard");
  const reportsAllowed = has("advanced_reports");
  const fuelAllowed = has("fuel");
  // AARTO fine workflow (G2) — Complete+ (aarto), farm roles only (not the contractor shell).
  const finesAllowed = !isWorkshop && has("aarto");
  // Logo/home link must point somewhere the role/plan can actually open. A contractor's
  // home is their aggregated dashboard (F12c).
  const homeHref = isWorkshop ? "/contractor" : isOperator ? "/driver" : dashAllowed ? "/dashboard" : "/machines";

  // The partner's own product ladder (0492), which is a different axis from the farm plan
  // above: `books` unlocks running the business here — the purchase and accounting half
  // (P&L, cash flow, VAT, expenses, suppliers, orders, bank reconciliation). The SALES
  // half (documents, statements, standing invoices, corrections) stays where 0382 put it,
  // so no partner loses a screen they already use. Hiding here is courtesy; the refusal
  // that matters is on each page and action.
  const booksAllowed = isWorkshop
    ? (await checkWorkshopEntitlement("financials", profile)).allowed
    : false;

  // Owner/manager activity inbox (F13): unread badge on the nav. Only the two roles that
  // own the inbox pay the extra query; the count runs under RLS (own farm only).
  let inboxUnread = 0;
  if (isManagerPlus) {
    const supabase = await createClient();
    inboxUnread = await countInboxUnread(supabase, profile.id);
  }

  // Multi-site switcher (F7): only for farm roles that can reach more than one farm.
  // Contractors (workshop) and rr_admin get [] from accessibleFarms and no switcher.
  // Support mode (S10): when an RR admin has pinned a farm, say so on every screen.
  const supporting = await supportFarm(profile);
  const farms = await accessibleFarms(profile);
  const currentFarm = isAdmin
    ? (await currentFarmId(profile)) ?? ""
    : farms.length > 1
      ? (await currentFarmId(profile)) ?? ""
      : profile.farm_id ?? "";
  const currentRole = currentFarm ? await effectiveFarmRole(currentFarm, profile) : null;
  const permissionState = await farmPermissionState(profile, currentFarm || null);
  // A named stock keeper must be able to reach the screen containing the controls the
  // grant opens. Baseline catalogue roles and RR's global catalogue stay unchanged.
  const canParts = Boolean(
    profile.role === "rr_admin" ||
      (currentRole && ["owner", "manager", "mechanic"].includes(currentRole)) ||
      permissionState.allows("manage_stock"),
  );
  const selectedFarmPlan = currentFarm && currentRole !== "rr_admin" ? await getFarmPlan(currentFarm) : null;
  // Unlike the gated content itself, the navigation entry stays discoverable. A farm on
  // a lower plan reaches the page's server-rendered upgrade notice, while every API still
  // rechecks the selected farm, role and Voice AI entitlement before doing any work.
  const assistantNavVisible = assistantNavigationVisible({
    isWorkshop,
    isAdmin,
    currentFarmId: currentFarm || null,
    hasCurrentFarmRole: currentRole !== null,
  });
  const apiTokensAllowed = Boolean(
    !isWorkshop &&
      currentFarm &&
      currentRole &&
      (currentRole === "rr_admin"
        ? supporting !== null
        : ["owner", "manager"].includes(currentRole) &&
          selectedFarmPlan &&
          planAllows(selectedFarmPlan, "api_access")),
  );
  const showSwitcher = farms.length > 1 && currentFarm !== "";
  const switcherLabel = t("nav.switchFarm", locale);

  // Nav catalogue (translated once, reused across shells).
  const contractor: NavItemData = { href: "/contractor", label: t("nav.contractor", locale), icon: "dashboard" };
  const driverHome: NavItemData = { href: "/driver", label: t("nav.driverHome", locale), icon: "dashboard" };
  const dashboard: NavItemData = { href: "/dashboard", label: t("nav.dashboard", locale), icon: "dashboard" };
  const machines: NavItemData = { href: "/machines", label: t("nav.machines", locale), icon: "machines" };
  const jobcards: NavItemData = { href: "/jobcards", label: t("nav.jobcards", locale), icon: "jobcards" };
  const faults: NavItemData = { href: "/faults", label: t("nav.faults", locale), icon: "faults" };
  const assistant: NavItemData = { href: "/assistant", label: t("nav.assistant", locale), icon: "mic" };
  const fuel: NavItemData = { href: "/fuel", label: t("nav.fuel", locale), icon: "fuel" };
  const parts: NavItemData = { href: "/parts", label: t("nav.parts", locale), icon: "parts" };
  const partners: NavItemData = { href: "/partners", label: t("nav.partners", locale), icon: "partners" };
  const checklists: NavItemData = { href: "/checklists", label: t("nav.checklists", locale), icon: "checklists" };
  const work: NavItemData = { href: "/work", label: t("nav.work", locale), icon: "work" };
  // Quotes & invoices (F14). Both sides of the same route: what a partner has issued,
  // what a farm has been sent. Never shown to operators — the RLS policy excludes them.
  const documents: NavItemData = { href: "/documents", label: t("nav.documents", locale), icon: "documents" };
  // A customer's account: what they owe and how it got there (G2). Partner-only — a farm
  // reads the same ledger from the other side, on the documents they were sent.
  const statements: NavItemData = { href: "/statements", label: t("nav.statements", locale), icon: "reports" };
  // Every change made to a document after it went out. Its own section, because "has
  // anyone been quietly moving numbers" is a question you ask without a document in mind.
  const corrections: NavItemData = { href: "/documents/corrections", label: t("nav.corrections", locale), icon: "documents" };
  // The books' other half (G6): what the partner BOUGHT, and what that means at filing
  // time. Partner-only — a farm never sees its contractor's purchases.
  // What the partner has ON ORDER but not yet been invoiced for. Sits immediately before
  // expenses because an order becomes one, and that is the order the two are used in.
  const orders: NavItemData = { href: "/orders", label: t("po.nav", locale), icon: "inbox" };
  // The bank statement queue. `download` rather than `inbox`: orders took the tray, and
  // two adjacent items sharing a glyph is how a nav stops being scannable.
  const banking: NavItemData = { href: "/banking", label: t("bank.nav", locale), icon: "download" };
  // The supplier book (G18). `partners` is the handshake glyph and reads as "businesses
  // we deal with"; the farm-side partners screen that also uses it is invisible to a
  // workshop, so the two never share a nav.
  const suppliers: NavItemData = { href: "/suppliers", label: t("supplier.navLabel", locale), icon: "partners" };
  // Costs that repeat (G19) - rent, insurance, the monthly parts account. Sits beside
  // expenses because it IS expenses, just the ones you should not have to remember.
  const recurringExpenses: NavItemData = { href: "/recurring-expenses", label: t("recexp.navLabel", locale), icon: "parts" };
  // What is ABOUT to happen (G20). /money says what did.
  const cashflow: NavItemData = { href: "/cashflow", label: t("cash.nav", locale), icon: "dashboard" };
  const expenses: NavItemData = { href: "/expenses", label: t("nav.expenses", locale), icon: "parts" };
  const vat: NavItemData = { href: "/vat", label: t("nav.vat", locale), icon: "reports" };
  // Hand the books over (FR-17.2). Last among the money screens on both sides, because it
  // is the end of the month rather than part of running it — and the only one of them a
  // FARM ever sees, which is why it is declared outside `booksItems`. `download` is the
  // banking glyph, which no farm-side nav shows, so the two never appear side by side.
  const accounting: NavItemData = { href: "/accounting", label: t("nav.accounting", locale), icon: "download" };
  // Did this month make money, who owes me, who do I owe (0460). Sits FIRST among the
  // money screens because it is the one you open without a document in mind.
  const money: NavItemData = { href: "/money", label: t("nav.money", locale), icon: "reports" };
  // Bills that go out on their own (G8). The failure it prevents is forgetting, so it
  // sits with the other money screens rather than in a settings corner.
  const recurring: NavItemData = { href: "/recurring", label: t("nav.recurring", locale), icon: "documents" };
  const partnerSettings: NavItemData = { href: "/contractor/settings", label: t("nav.partnerSettings", locale), icon: "settings" };
  // A partner's own client book (F15) — their whole customer list, not only the farms
  // that happened to find them.
  const clients: NavItemData = { href: "/contractor/clients", label: t("nav.clients", locale), icon: "team" };
  const fines: NavItemData = { href: "/fines", label: t("nav.fines", locale), icon: "fines" };
  const inbox: NavItemData = { href: "/inbox", label: t("nav.inbox", locale), icon: "inbox", badge: inboxUnread || undefined };
  const reports: NavItemData = { href: "/reports", label: t("nav.reports", locale), icon: "reports" };
  const alerts: NavItemData = { href: "/notifications", label: t("nav.notifications", locale), icon: "bell" };
  const team: NavItemData = { href: "/team", label: t("nav.team", locale), icon: "team" };
  const settings: NavItemData = { href: "/settings", label: t("nav.settings", locale), icon: "settings" };
  const apiTokens: NavItemData = { href: "/settings/api", label: t("nav.apiTokens", locale), icon: "settings" };
  // Every role, including drivers and contractors: putting it on the phone is the
  // point of an offline-first product, and it was reachable from nowhere.
  const install: NavItemData = { href: "/install", label: t("nav.install", locale), icon: "download" };
  const admin: NavItemData = { href: "/admin/farms", label: t("nav.admin", locale), icon: "admin" };

  // Mobile: primary tabs + a "More" sheet holding the rest (gated items dropped).
  // Contractors get a contractor-first tab set; everyone else the farm set.
  const tabItems: NavItemData[] = isWorkshop
    ? [contractor, clients, work, documents]
    : isOperator
      ? [driverHome, machines, faults]
      : [...(dashAllowed ? [dashboard] : []), machines, jobcards];
  // The eight screens that make up running the books here (0492). Listed once and reused
  // by both shells, so the phone and the desktop can never disagree about what a
  // partner's product includes.
  const booksItems: NavItemData[] = booksAllowed
    ? [money, cashflow, orders, expenses, recurringExpenses, suppliers, banking, vat, accounting]
    : [];
  const moreItems: NavItemData[] = isWorkshop
    ? [clients, documents, statements, recurring, ...booksItems, corrections, machines, jobcards, checklists, alerts, partnerSettings, install]
    : [
        ...(isManagerPlus ? [inbox] : []),
        faults,
        ...(assistantNavVisible ? [assistant] : []),
        work,
        ...(isManagerPlus ? [documents] : []),
        ...(fuelAllowed ? [fuel] : []),
        ...(canParts ? [parts] : []),
        ...(canPartners ? [partners] : []),
        checklists,
        ...(finesAllowed ? [fines] : []),
        ...(reportsAllowed ? [reports] : []),
        ...(reportsAllowed && isManagerPlus ? [accounting] : []),
        alerts,
        ...(apiTokensAllowed ? [apiTokens] : []),
        ...(isManagerPlus ? [team, settings] : []),
        ...(isAdmin ? [admin] : []),
        install,
      ];

  // Desktop: grouped sidebar sections (gated items dropped).
  const overviewItems: NavItemData[] = [
    ...(dashAllowed ? [dashboard] : []),
    ...(isManagerPlus ? [inbox] : []),
    ...(reportsAllowed ? [reports] : []),
    ...(reportsAllowed && isManagerPlus ? [accounting] : []),
  ];
  const groups: { key: string; label: string; items: NavItemData[] }[] = isOperator
    ? [
        { key: "overview", label: t("nav.groupOverview", locale), items: [driverHome] },
        { key: "fleet", label: t("nav.theFleet", locale), items: [machines, ...(assistantNavVisible ? [assistant] : []), faults, ...(fuelAllowed ? [fuel] : [])] },
      ]
    : isWorkshop
    ? [
        { key: "contractor", label: t("nav.groupContractor", locale), items: [contractor, clients, work, documents, statements, recurring, ...booksItems, corrections] },
        { key: "workshop", label: t("nav.groupWorkshop", locale), items: [machines, jobcards, faults, checklists] },
        { key: "farm", label: t("nav.groupFarm", locale), items: [alerts, partnerSettings] },
      ]
    : [
        ...(overviewItems.length ? [{ key: "overview", label: t("nav.groupOverview", locale), items: overviewItems }] : []),
        {
          key: "fleet",
          label: t("nav.theFleet", locale),
          items: [machines, ...(assistantNavVisible ? [assistant] : []), faults, jobcards, work, ...(fuelAllowed ? [fuel] : [])],
        },
        {
          key: "farm",
          label: t("nav.groupFarm", locale),
          items: [...(isManagerPlus ? [documents, corrections, team] : []), alerts],
        },
      ];

  /*
    The long tail. It used to sit behind an "Everything else" disclosure in the sidebar,
    which meant parts, partners, checklists, fines, settings, admin and install were
    invisible until you found and opened a summary — a person who never did had no way
    to know those screens existed.

    They are now a named group like any other, and the whole panel scrolls with a visible
    scrollbar and an edge fade (see ScrollArea). Nothing in the nav is hidden from anyone
    who is allowed to reach it.
  */
  const tailItems: NavItemData[] = isWorkshop
    ? [partnerSettings, parts, install]
    : [
        ...(canParts ? [parts] : []),
        ...(canPartners ? [partners] : []),
        checklists,
        ...(finesAllowed ? [fines] : []),
        ...(apiTokensAllowed ? [apiTokens] : []),
        ...(isManagerPlus ? [settings] : []),
        ...(isAdmin ? [admin] : []),
        install,
      ];

  const appName = t("app.name", locale);
  const signOutLabel = t("nav.signOut", locale);
  const languageLabel = t("nav.language", locale);

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
      className="focus-ring inline-flex min-h-[48px] items-center gap-1.5 rounded-lg px-2 text-[1.4rem] text-sand-600 hover:bg-sand-100 sm:min-h-[44px]"
    >
      <BellIcon />
      {/* Icon and word. A bell alone is guessable; "Alerts" is not. */}
      <span className="text-sm font-medium">{t("nav.notifications", locale)}</span>
    </Link>
  );

  // Footer slot for the "More" sheet: language switch + sign-out (server action stays
  // server-side).
  const signOutSlot = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-3 py-1">
        <span className="text-[0.95rem] font-medium text-sand-800">{languageLabel}</span>
        <LanguageSwitcher current={languageChoice} label={languageLabel} />
      </div>
      <AssistantSafeSignOutForm action={signOut} locale={locale}>
        <button
          type="submit"
          className="focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-[0.95rem] font-medium text-sand-800 hover:bg-sand-100"
        >
          <SignOutIcon className="text-[1.35rem] text-sand-500" />
          {signOutLabel}
        </button>
      </AssistantSafeSignOutForm>
    </div>
  );

  // Everything this role can reach, deduped — handed to the service worker so those
  // screens are there when the signal is not (see WarmRoutes / sw.js).
  const warmPaths = [
    ...new Set(
      [...groups.flatMap((g) => g.items), ...tailItems, ...tabItems, ...moreItems].map((i) => i.href),
    ),
  ];

  return (
    <div className="min-h-dvh">
      <WarmRoutes paths={warmPaths} contextKey={`${profile.id}:${currentFarm || profile.farm_id || ""}`} />
      {supporting ? <SupportBanner farmName={supporting.name} locale={locale} /> : null}

      {/* ---- Desktop sidebar (>=1024px) ---- */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sand-200 bg-white lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-4">
          {brandMark}
          <span className="text-lg font-bold tracking-tight text-sand-900">{appName}</span>
        </div>
        {showSwitcher && (
          <div className="px-3 pb-2">
            <SiteSwitcher farms={farms} current={currentFarm} label={switcherLabel} />
          </div>
        )}
        <ScrollArea label={t("nav.menu", locale)} className="px-3 py-2" fadeClassName="from-white">
          <nav className="space-y-5">
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
            {tailItems.length > 0 ? (
              <div className="space-y-1">
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-sand-400">
                  {t("nav.everythingElse", locale)}
                </p>
                {tailItems.map((item) => (
                  <NavLink key={item.href} item={item} variant="sidebar" />
                ))}
              </div>
            ) : null}
          </nav>
        </ScrollArea>
        <div className="border-t border-sand-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-sand-400">
              {languageLabel}
            </span>
            <LanguageSwitcher current={languageChoice} label={languageLabel} />
          </div>
          <div className="mb-1 flex items-center gap-2.5 px-1">
            {avatar}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-sand-900">{profile.name}</span>
              <span className="block truncate text-xs capitalize text-sand-500">{profile.role}</span>
            </span>
          </div>
          <AssistantSafeSignOutForm action={signOut} locale={locale}>
            <button
              type="submit"
              className="focus-ring flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-sand-600 hover:bg-sand-100 hover:text-sand-900"
            >
              <SignOutIcon className="text-[1.25rem]" />
              {signOutLabel}
            </button>
          </AssistantSafeSignOutForm>
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

        {/* Mobile site switcher (F7) — only when the account can reach >1 farm */}
        {showSwitcher && (
          <div className="sticky top-[57px] z-10 border-b border-sand-200 bg-white/95 px-4 py-2 backdrop-blur lg:hidden">
            <SiteSwitcher farms={farms} current={currentFarm} label={switcherLabel} />
          </div>
        )}

        {/* Desktop slim top bar */}
        <header className="sticky top-0 z-20 hidden items-center justify-end gap-1.5 border-b border-sand-200 bg-white/90 px-6 py-2 backdrop-blur lg:flex">
          <SyncStatus locale={locale} />
          {bellLink}
          {avatar}
        </header>

        <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 pb-24 pt-5 sm:px-6 lg:px-8 lg:pb-10">
          <Tour steps={tourFor(profile.role)} locale={locale} homePath={homeHref} />
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
          {/* The daily action — report a problem — was nowhere in the chrome. It is
              now a permanent green target, not an item buried in "More". */}
          {!isWorkshop ? (
            <Link
              href="/faults"
              className="focus-ring flex min-w-[64px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl bg-brand-600 text-white"
              aria-label={t("nav.reportProblemLong", locale)}
            >
              <FaultsIcon className="text-[1.35rem]" />
              <span className="text-[0.7rem] font-semibold leading-none">{t("nav.reportProblem", locale)}</span>
            </Link>
          ) : null}
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
