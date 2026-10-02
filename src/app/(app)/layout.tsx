import { redirect } from "next/navigation";
import { cookies } from "next/headers";
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
import { farmBillingGate } from "@/lib/billing/service";
import { createClient } from "@/lib/supabase/server";
import { countInboxUnread } from "@/lib/inbox";
import { countInboxDecisions } from "@/lib/inbox-decisions";
import { t } from "@/lib/i18n";
import { roleLabel } from "@/lib/format";
import { signOut } from "./actions";
import { AssistantSafeSignOutForm } from "@/components/assistant/sign-out-form";
// Direct module imports keep every (app) route's client bundle to just the nav
// interactivity, the barrel would pull the kit's full client chunk (see
// src/components/ui/README.md).
import { NavLink, MoreMenu, type NavItemData } from "@/components/ui/nav";
import {
  BellIcon,
  MachinesIcon,
  SignOutIcon,
  FaultsIcon,
  ChevronUpIcon,
  SettingsIcon,
} from "@/components/ui/icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ActionMenu } from "@/components/ui/action-menu";
import { menuItemClass } from "@/components/ui/menu-item";
// Direct, not the barrel: see the note above. The palette is the only new
// client code this shell pulls, and it is one list plus two arrow keys.
import { CommandPalette, SearchButton, type CommandAction } from "@/components/ui/command-palette";
import { WarmRoutes } from "@/components/offline/warm-routes";
import { SupportBanner } from "@/components/support-banner";
import { SiteSwitcher, SiteSwitcherChip } from "@/components/ui/site-switcher";
import { LanguageSwitcher } from "@/components/ui/language-switcher";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SyncStatus } from "@/components/offline/sync-status";
import { Tour } from "@/components/tour";
import { tourFor } from "@/lib/tour";
import { farmPermissionState } from "@/lib/permissions";
import { assistantNavigationVisible } from "@/lib/assistant/navigation";
import {
  START_COOKIE,
  TABS_COOKIE,
  destinationsFor,
  maxTabsFor,
  parseTabs,
  pinnableDestinations,
  resolveStartPath,
  standardHomeFor,
} from "@/lib/preferences";

/**
 * Two-letter initials from a display name, for the avatar chip. A bracketed part is
 * not a name ("Johan (Werkswinkel)" rendered "J("), and neither is punctuation, so
 * both are dropped before taking letters.
 */
function initials(name: string): string {
  const parts = name
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
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

  // A farm that signed up and has not paid gets no app at all, just the screen that takes
  // the payment. This is the only place the check lives, because this layout wraps every
  // authenticated farm screen and nothing else: /login, the public QR page, the API routes
  // and /activate itself all sit outside it, so /activate cannot bounce to itself.
  //
  // `farmBillingGate` answers "pending" ONLY when a subscription row exists and has not
  // been paid. No subscription row at all is "ok", that is Weltevrede and every farm
  // onboarded before billing existed, and the inverse reading would lock out the whole
  // customer base. It is role-independent by construction too: an operator cannot read the
  // subscription row itself, so a layout that queried the table directly would fail OPEN
  // for exactly the people who never look at billing.
  //
  // 'closed' is the other end of the same story (20260911180000): a farm that cancelled,
  // or that walked the whole dunning ladder and then sat past the lapsed window, or that
  // Rapid Rise suspended. Until that migration the gate had no such state and NOTHING ever
  // took access away, a farm that stopped paying kept the product on the downgrade plan
  // for ever, and a farm that cancelled kept all of it.
  if (profile.farm_id && profile.role !== "rr_admin" && profile.role !== "workshop") {
    const gateClient = await createClient();
    const gate = await farmBillingGate(gateClient, profile.farm_id);
    if (gate === "pending") redirect("/activate");
    if (gate === "closed") redirect("/closed");
  }

  const locale = profile.lang;
  // The EN/AF control shows the LANGUAGE choice, which is independent of tone, a
  // professional-tone Afrikaans user must still see AF selected, not "af-pro".
  const languageChoice = profile.language;
  const isManagerPlus = profile.role === "owner" || profile.role === "manager";
  const isOwner = profile.role === "owner";
  const isAdmin = profile.role === "rr_admin";
  // Contractors (workshop role) get a tailored, contractor-first shell (F12c): their
  // aggregated dashboard is home, and farm-only surfaces are dropped.
  const isWorkshop = profile.role === "workshop";
  const isOperator = profile.role === "operator";
  // Parts catalogue & service kits (F9), maintained by farm crew + RR admin (global lib).
  // Partners directory (F12a), farmer-facing (browse/add/connect contractors) + RR admin
  // (curates the global suggested catalogue). Workshop users have their own views (F12c).
  const canPartners = profile.role !== "workshop";

  // Entitlement-aware nav (F5): hide surfaces the farm's plan does not unlock.
  // plan == null → rr_admin/workshop bypass (everything visible).
  const has = (f: Parameters<typeof planAllows>[1]) => plan == null || planAllows(plan, f);
  const dashAllowed = has("dashboard");
  const reportsAllowed = has("advanced_reports");
  const fuelAllowed = has("fuel");
  // AARTO fine workflow (G2), Complete+ (aarto), farm roles only (not the contractor shell).
  const finesAllowed = !isWorkshop && has("aarto");
  // The role's standard home, somewhere the role/plan can actually open. A contractor's
  // home is their aggregated dashboard (F12c). It is the phone bar's first tab and the
  // tour's page; the logo honours a chosen start page on top of it (below).
  const homeHref = standardHomeFor(profile.role, plan);
  // Device preferences written by /account (src/lib/preferences.ts): the start page and
  // the pinned phone shortcuts. Both are read through the same helpers and the same
  // role/plan lists the account page offers and its actions validate, so the shell can
  // never show a choice the page did not make, or miss one it did.
  const prefCookies = await cookies();
  const logoHref = resolveStartPath(
    prefCookies.get(START_COOKIE)?.value,
    destinationsFor(profile.role, plan),
    homeHref,
  );

  // The partner's own product ladder (0492), which is a different axis from the farm plan
  // above: `books` unlocks running the business here, the purchase and accounting half
  // (P&L, cash flow, VAT, expenses, suppliers, orders, bank reconciliation). The SALES
  // half (documents, statements, standing invoices, corrections) stays where 0382 put it,
  // so no partner loses a screen they already use. Hiding here is courtesy; the refusal
  // that matters is on each page and action.
  const booksAllowed = isWorkshop
    ? (await checkWorkshopEntitlement("financials", profile)).allowed
    : false;

  // Two counts, two places. The header bell carries the person's unread alerts (every
  // role has alerts; one head-only count under RLS). The Inbox nav item carries only the
  // decisions waiting on the owner (quotes to accept, invoices to approve): it used to
  // carry the unread alerts, which sat at 77 on every screen while the inbox asked for 3.
  const countsClient = await createClient();
  const [alertsUnread, inboxDecisions] = await Promise.all([
    countInboxUnread(countsClient, profile.id),
    isManagerPlus ? countInboxDecisions(countsClient, profile.farm_id) : Promise.resolve(0),
  ]);

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
  // what a farm has been sent. Never shown to operators, the RLS policy excludes them.
  const documents: NavItemData = { href: "/documents", label: t("nav.documents", locale), icon: "documents" };
  // A customer's account: what they owe and how it got there (G2). Partner-only, a farm
  // reads the same ledger from the other side, on the documents they were sent.
  const statements: NavItemData = { href: "/statements", label: t("nav.statements", locale), icon: "reports" };
  // Every change made to a document after it went out. Its own section, because "has
  // anyone been quietly moving numbers" is a question you ask without a document in mind.
  const corrections: NavItemData = { href: "/documents/corrections", label: t("nav.corrections", locale), icon: "correction" };
  // The books' other half (G6): what the partner BOUGHT, and what that means at filing
  // time. Partner-only, a farm never sees its contractor's purchases.
  // What the partner has ON ORDER but not yet been invoiced for. Sits immediately before
  // expenses because an order becomes one, and that is the order the two are used in.
  const orders: NavItemData = { href: "/orders", label: t("po.nav", locale), icon: "inbox" };
  // The bank statement queue. `download` rather than `inbox`: orders took the tray, and
  // two adjacent items sharing a glyph is how a nav stops being scannable.
  const banking: NavItemData = { href: "/banking", label: t("bank.nav", locale), icon: "bank" };
  // The supplier book (G18). `partners` is the handshake glyph and reads as "businesses
  // we deal with"; the farm-side partners screen that also uses it is invisible to a
  // workshop, so the two never share a nav.
  const suppliers: NavItemData = { href: "/suppliers", label: t("supplier.navLabel", locale), icon: "partners" };
  // Costs that repeat (G19) - rent, insurance, the monthly parts account. Sits beside
  // expenses because it IS expenses, just the ones you should not have to remember.
  const recurringExpenses: NavItemData = { href: "/recurring-expenses", label: t("recexp.navLabel", locale), icon: "cart" };
  // What is ABOUT to happen (G20). /money says what did.
  const cashflow: NavItemData = { href: "/cashflow", label: t("cash.nav", locale), icon: "trending" };
  const expenses: NavItemData = { href: "/expenses", label: t("nav.expenses", locale), icon: "receipt" };
  const vat: NavItemData = { href: "/vat", label: t("nav.vat", locale), icon: "percent" };
  // Hand the books over (FR-17.2). Last among the money screens on both sides, because it
  // is the end of the month rather than part of running it, and the only one of them a
  // FARM ever sees, which is why it is declared outside `booksItems`. `download` is the
  // banking glyph, which no farm-side nav shows, so the two never appear side by side.
  const accounting: NavItemData = { href: "/accounting", label: t("nav.accounting", locale), icon: "calculator" };
  // Did this month make money, who owes me, who do I owe (0460). Sits FIRST among the
  // money screens because it is the one you open without a document in mind.
  const money: NavItemData = { href: "/money", label: t("nav.money", locale), icon: "cash" };
  // Bills that go out on their own (G8). The failure it prevents is forgetting, so it
  // sits with the other money screens rather than in a settings corner.
  const recurring: NavItemData = { href: "/recurring", label: t("nav.recurring", locale), icon: "repeat" };
  const partnerSettings: NavItemData = { href: "/contractor/settings", label: t("nav.partnerSettings", locale), icon: "settings" };
  // A partner's own client book (F15), their whole customer list, not only the farms
  // that happened to find them.
  const clients: NavItemData = { href: "/contractor/clients", label: t("nav.clients", locale), icon: "team" };
  const fines: NavItemData = { href: "/fines", label: t("nav.fines", locale), icon: "fines" };
  // Accidents and the claim that follows (2.4). Beside fines rather than beside faults: a
  // collision and a speeding ticket are both paperwork with a deadline on them, and a
  // breakdown is not.
  const incidents: NavItemData = { href: "/incidents", label: t("nav.incidents", locale), icon: "warning" };
  // Everything with a date on it, in one month. Beside the work screens rather than the
  // reports, because it is a planning tool and not a look back.
  const calendar: NavItemData = { href: "/calendar", label: t("nav.calendar", locale), icon: "calendar" };
  // A question straight to us, with the context already attached. Beside settings, which
  // is where somebody goes when they are looking for a way out of a problem.
  const help: NavItemData = { href: "/help", label: t("nav.help", locale), icon: "info" };
  // Tyres sit with parts: both are consumables bought, fitted and worn out, and a farm
  // looking for one is in the same frame of mind as a farm looking for the other.
  const tyres: NavItemData = { href: "/tyres", label: t("nav.tyres", locale), icon: "tyre" };
  const inbox: NavItemData = { href: "/inbox", label: t("nav.inbox", locale), icon: "inbox", badge: inboxDecisions || undefined };
  const reports: NavItemData = { href: "/reports", label: t("nav.reports", locale), icon: "reports" };
  const alerts: NavItemData = { href: "/notifications", label: t("nav.notifications", locale), icon: "bell" };
  const team: NavItemData = { href: "/team", label: t("nav.team", locale), icon: "team" };
  const settings: NavItemData = { href: "/settings", label: t("nav.settings", locale), icon: "settings" };
  const apiTokens: NavItemData = { href: "/settings/api", label: t("nav.apiTokens", locale), icon: "key" };
  // Every role, including drivers and contractors: putting it on the phone is the
  // point of an offline-first product, and it was reachable from nowhere.
  const install: NavItemData = { href: "/install", label: t("nav.install", locale), icon: "download" };
  // What the farm pays Rapid Rise for the software. The OWNER's business and nobody
  // else's on the farm side, a manager runs the fleet, they do not hold the card, so
  // this is gated on the role rather than on a plan entitlement. The route re-checks it
  // server-side; hiding a nav item is not access control.
  const billing: NavItemData = { href: "/billing", label: t("nav.billing", locale), icon: "card" };
  const adminBilling: NavItemData = { href: "/admin/billing", label: t("nav.adminBilling", locale), icon: "repeat" };
  // The Rapid Rise console's own sections. They used to be one "Admin" row filed under
  // Account plus an English-only text subnav inside the page; now they are one group.
  const admin: NavItemData = { href: "/admin/farms", label: t("nav.adminFarms", locale), icon: "admin" };
  const adminPartners: NavItemData = { href: "/admin/partners", label: t("nav.adminPartners", locale), icon: "partners" };
  const adminTemplates: NavItemData = { href: "/admin/templates", label: t("nav.adminTemplates", locale), icon: "documents" };
  // Reached from the account menu and the palette, not listed in the sidebar: the menu
  // on the row that names you is where people look for their own account.
  const yourAccount: NavItemData = { href: "/account", label: t("nav.account", locale), icon: "settings" };

  // Mobile: primary tabs + a "More" sheet holding the rest (gated items dropped).
  // Contractors get a contractor-first tab set; everyone else the farm set.
  //
  // Drivers: Faults is NOT a tab. The permanent green Report button beside the tabs goes
  // to the same page, so two of five slots opened /faults. Fuel takes the slot when the
  // plan has it; otherwise the bar has one fewer, wider tab. Faults stays in More.
  const defaultTabs: NavItemData[] = isWorkshop
    ? [contractor, clients, work, documents]
    : isOperator
      ? [driverHome, machines, ...(fuelAllowed ? [fuel] : [])]
      : [...(dashAllowed ? [dashboard] : []), machines, jobcards];
  // The eight screens that make up running the books here (0492). Listed once and reused
  // by both shells, so the phone and the desktop can never disagree about what a
  // partner's product includes.
  const booksItems: NavItemData[] = booksAllowed
    ? [money, cashflow, orders, expenses, recurringExpenses, suppliers, banking, vat, accounting]
    : [];
  const moreItems: NavItemData[] = isWorkshop
    ? [clients, documents, statements, recurring, ...booksItems, corrections, machines, jobcards, checklists, parts, partnerSettings, install]
    : [
        ...(isManagerPlus ? [inbox] : []),
        faults,
        ...(assistantNavVisible ? [assistant] : []),
        work,
        ...(isManagerPlus ? [documents] : []),
        ...(fuelAllowed ? [fuel] : []),
        ...(canParts ? [parts] : []),
        tyres,
        ...(canPartners ? [partners] : []),
        checklists,
        ...(finesAllowed ? [fines] : []),
        incidents,
        calendar,
        ...(reportsAllowed ? [reports] : []),
        ...(reportsAllowed && isManagerPlus ? [accounting] : []),
        alerts,
        ...(apiTokensAllowed ? [apiTokens] : []),
        ...(isManagerPlus ? [team, settings] : []),
        ...(isAdmin ? [admin, adminPartners, adminTemplates, adminBilling] : []),
        help,
        install,
      ];

  // Desktop: grouped sidebar sections (gated items dropped).
  const overviewItems: NavItemData[] = [
    ...(dashAllowed ? [dashboard] : []),
    ...(isManagerPlus ? [inbox] : []),
    ...(reportsAllowed ? [reports] : []),
    ...(reportsAllowed && isManagerPlus ? [accounting] : []),
  ];
  /*
    "Alerts" is no longer a nav row. The bell is permanent in both top bars and now carries
    the unread count, so the row was the same destination a second (and on phones a third)
    time. It stays reachable from the command palette.

    Contractors get real groups instead of one 16-row "Contractor" heading with the Books
    screens mixed in and a "Farm" group for a business that is not a farm: what they sell,
    the books (only when entitled), the workshop, and their business settings.
  */
  const groups: { key: string; label: string; items: NavItemData[] }[] = (isOperator
    ? [
        { key: "overview", label: t("nav.groupOverview", locale), items: [driverHome] },
        { key: "fleet", label: t("nav.theFleet", locale), items: [machines, ...(assistantNavVisible ? [assistant] : []), faults, ...(fuelAllowed ? [fuel] : [])] },
      ]
    : isWorkshop
    ? [
        { key: "sales", label: t("nav.groupSales", locale), items: [contractor, clients, work, documents, statements, recurring, corrections] },
        { key: "books", label: t("nav.groupBooks", locale), items: booksItems },
        { key: "workshop", label: t("nav.groupWorkshop", locale), items: [machines, jobcards, faults, checklists, parts] },
        { key: "business", label: t("nav.groupBusiness", locale), items: [partnerSettings] },
      ]
    : [
        ...(isAdmin
          ? [{ key: "rapidrise", label: t("nav.groupRapidRise", locale), items: [admin, adminPartners, adminTemplates, adminBilling] }]
          : []),
        ...(overviewItems.length ? [{ key: "overview", label: t("nav.groupOverview", locale), items: overviewItems }] : []),
        {
          key: "fleet",
          label: t("nav.theFleet", locale),
          items: [machines, ...(assistantNavVisible ? [assistant] : []), faults, jobcards, work, ...(fuelAllowed ? [fuel] : [])],
        },
        {
          key: "farm",
          label: t("nav.groupFarm", locale),
          items: isManagerPlus ? [documents, corrections, team] : [],
        },
      ]
  ).filter((g) => g.items.length > 0);

  /*
    The long tail. It used to sit behind an "Everything else" disclosure in the sidebar,
    which meant parts, partners, checklists, fines, settings, admin and install were
    invisible until you found and opened a summary, a person who never did had no way
    to know those screens existed.

    They are now named groups like any other, and the whole panel scrolls with a visible
    scrollbar and an edge fade (see ScrollArea). Nothing in the nav is hidden from anyone
    who is allowed to reach it.

    Three groups and not one. "Everything else" had grown to twelve destinations for an
    owner, which is a bucket, not a heading, and the sticky headings added above make a
    heading that says nothing more conspicuous rather than less. Two of those twelve are
    unarguably a different KIND of thing from the other ten, so they are named: what you
    do to your account (settings, billing, API access, and the cross-tenant admin
    screens) and where you go for help. The remaining operational screens keep the
    founder's existing label, because inventing a taxonomy for them is a product
    decision and not a UI one.
  */
  const tailAccount: NavItemData[] = isWorkshop
    ? []
    : [
        ...(apiTokensAllowed ? [apiTokens] : []),
        ...(isManagerPlus ? [settings] : []),
        ...(isOwner ? [billing] : []),
        ...(isAdmin ? [billing] : []),
      ];
  const tailRest: NavItemData[] = isWorkshop
    // Parts moved into the contractor's "Workshop" group, beside the job cards it serves.
    ? []
    : [
        ...(canParts ? [parts] : []),
        tyres,
        ...(canPartners ? [partners] : []),
        checklists,
        ...(finesAllowed ? [fines] : []),
        incidents,
        calendar,
      ];
  // Not /help for contractors yet: `open_help_request` refuses a profile without a farm
  // ("Only a farm member can ask for help here"), so the row would lead to a form that fails.
  const tailHelp: NavItemData[] = isWorkshop ? [install] : [help, install];

  /**
   * One definition of the tail, spread by all four consumers (sidebar, "More" sheet,
   * command palette, service-worker warm list). They used to rebuild
   * `{ key: "tail", label: nav.everythingElse, items: tailItems }` at three separate
   * call sites, which is three chances to disagree about what the tail is.
   *
   * Deduped by href: an account that is BOTH owner and rr_admin matched
   * `isOwner ? [billing]` and `isAdmin ? [..., billing]`, and got the same
   * destination twice in one group.
   */
  const tailGroups: { key: string; label: string; items: NavItemData[] }[] = [
    { key: "tail", label: t("nav.everythingElse", locale), items: tailRest },
    { key: "account", label: t("nav.groupAccount", locale), items: tailAccount },
    { key: "help", label: t("nav.groupHelp", locale), items: tailHelp },
  ]
    .map((g) => ({
      ...g,
      items: g.items.filter((i, n) => g.items.findIndex((o) => o.href === i.href) === n),
    }))
    .filter((g) => g.items.length > 0);

  // Everything this role may open in the nav, the catalogue both the pinned tabs and the
  // active-state exclusions are checked against.
  const navItems = [...groups.flatMap((g) => g.items), ...tailGroups.flatMap((g) => g.items), ...defaultTabs];
  const navByHref = new Map(navItems.map((i) => [i.href, i]));

  /*
    Pinned phone tabs (cookie `fw_tabs`, written from /account): the hrefs a person chose
    for the slots after the first tab. `parseTabs` keeps only `pinnableDestinations`
    (the role/plan list the account page offers, minus the first tab) and at most
    `maxTabsFor(role)`, which keeps the bar at five slots: first tab, pins, Report (farm
    roles) and More. Each href is then mapped to this role's own nav item (plus Alerts,
    which every role has), so a cookie can never add a destination the nav would not
    show. No valid pin keeps today's defaults.
  */
  const homeTab = defaultTabs[0];
  const pinnable = new Map([...navByHref, [alerts.href, alerts]]);
  const pinned = parseTabs(
    prefCookies.get(TABS_COOKIE)?.value,
    pinnableDestinations(profile.role, plan),
    maxTabsFor(profile.role),
  )
    .filter((h) => h !== homeTab.href)
    .map((h) => pinnable.get(h))
    .filter((i): i is NavItemData => Boolean(i));
  const tabItems: NavItemData[] = pinned.length > 0 ? [homeTab, ...pinned] : defaultTabs;

  /*
    Active state: the most specific item wins. Each item learns which other nav hrefs sit
    under it, so "Quotes & invoices" (/documents) is not lit beside "Corrections"
    (/documents/corrections), nor "Settings" beside "API access", nor "My dashboard"
    (/contractor) beside "My clients" on a contractor's tab bar.
  */
  const navHrefs = [...navByHref.keys()];
  for (const item of new Set(navItems)) {
    const below = navHrefs.filter((h) => h !== item.href && h.startsWith(item.href + "/"));
    if (below.length > 0) item.excludes = below;
  }

  /*
    The "More" sheet used to be a FLAT, ungrouped list built by hand, for a
    books-tier partner that was 21 undifferentiated rows, while the SAME person's
    desktop sidebar was organised into three named groups. The phone and the
    desktop disagreed about what the product is.

    It is now DERIVED from the sidebar's own `groups` + `tailGroups`, so the two
    shells cannot drift again, minus whatever already has a permanent tab at the
    bottom of the screen (no point listing it twice). `moreItems` above is kept
    only as a flat source for the service worker's warm list.
  */
  const tabHrefs = new Set(tabItems.map((i) => i.href));
  const moreGroups = [
    ...groups,
    ...tailGroups,
  ]
    .map((g) => ({ ...g, items: g.items.filter((i) => !tabHrefs.has(i.href)) }))
    .filter((g) => g.items.length > 0);

  /**
   * What Ctrl/⌘+K can reach. Built from the same server-computed `groups` and
   * `tailGroups` as the sidebar, so the palette cannot offer a destination this
   * role may not open, but WITHOUT `moreGroups`' tab filter, because a tab
   * being on screen is no reason you should not be able to type its name.
   */
  const personalItems: NavItemData[] = [yourAccount, alerts];
  const paletteBase = [...groups, ...tailGroups];
  const paletteGroups = (
    paletteBase.some((g) => g.key === "account")
      ? paletteBase.map((g) => (g.key === "account" ? { ...g, items: [...personalItems, ...g.items] } : g))
      : [...paletteBase, { key: "account", label: t("nav.groupAccount", locale), items: personalItems }]
  ).filter((g) => g.items.length > 0);

  /*
    Quick verbs for the palette, only for roles that can do them. Each links to the
    screen that holds the action ("?report=1" asks /faults to open its report dialog).
  */
  const paletteActions: CommandAction[] = [
    ...(!isWorkshop ? [{ href: "/faults?report=1", label: t("faults.report", locale), icon: "faults" as const }] : []),
    ...(!isWorkshop && fuelAllowed ? [{ href: "/fuel", label: t("command.logDiesel", locale), icon: "fuel" as const }] : []),
    ...(isManagerPlus ? [{ href: "/machines/new", label: t("onboarding.step1Cta", locale), icon: "plus" as const }] : []),
  ];

  const appName = t("app.name", locale);
  const signOutLabel = t("nav.signOut", locale);
  const languageLabel = t("nav.language", locale);
  const themeLabel = t("nav.appearance", locale);
  const themeLabels = {
    system: t("nav.themeSystem", locale),
    light: t("nav.themeLight", locale),
    dark: t("nav.themeDark", locale),
  };

  const brandMark = (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-xl text-white shadow-xs">
      <MachinesIcon />
    </span>
  );

  // Decorative inside whichever button carries it; the button has the name.
  const avatar = (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand-ink"
    >
      {initials(profile.name)}
    </span>
  );

  const accountLabel = t("nav.account", locale);
  const accountPrefsLabel = t("nav.accountAndPrefs", locale);
  const alertsWord = t("nav.notifications", locale);
  const bellLabel =
    alertsUnread > 0 ? t("nav.alertsUnread", locale).replace("{count}", String(alertsUnread)) : alertsWord;

  /*
    The bell: icon plus unread count on phones, icon plus word from `sm:` up.

    It used to show the word at every width. In Afrikaans that is "Kennisgewings", and
    with the "Aanlyn" pill beside it the phone header was 394px wide in a 360px viewport,
    so Chrome zoomed EVERY page out for every Afrikaans phone user. On a phone the bell
    now has its name for screen readers and a count badge that sits over the icon (no
    width), which also puts the unread number where people look for news.

    Width budget of the phone header at 360px (328px inside px-4), Afrikaans, worst case:
    search 48 + sync pill at most 116 ("Vanlyn · 3", "Sinkroniseer…", label capped at
    5rem) + bell 48 + avatar 48 + three 4px gaps = 272, leaving 56 for the 36px brand mark
    and an 8px gap. The farm chip and the wordmark are the only things that shrink, and
    they truncate. Online (the normal case) the pill is a 16px dot, so 156px is left.
  */
  const bellLink = (
    <Link
      href="/notifications"
      aria-label={bellLabel}
      className="focus-ring inline-flex h-12 min-w-[48px] shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xl text-sand-600 hover:bg-sand-100 sm:h-11 sm:justify-start"
    >
      <span className="relative inline-flex">
        <BellIcon aria-hidden />
        {alertsUnread > 0 ? (
          <span className="absolute -right-2 -top-1.5 inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-brand-600 px-1 text-2xs font-bold leading-4 text-white ring-2 ring-surface">
            {alertsUnread > 9 ? "9+" : alertsUnread}
          </span>
        ) : null}
      </span>
      <span className="hidden text-sm font-medium sm:inline">{alertsWord}</span>
    </Link>
  );

  /*
    The account menu, one set of rows reached from three places: the sidebar's account
    row, the phone header avatar and the desktop top-bar avatar. The avatars used to be
    dead chips, and /account (name, email, password, preferences) was linked from nowhere
    in the app.
  */
  const accountMenuRows = (
    <>
      <Link href="/account" className={menuItemClass()}>
        <SettingsIcon className="text-xl text-sand-500" aria-hidden />
        {accountPrefsLabel}
      </Link>
      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <span className="text-sm font-medium text-sand-800">{languageLabel}</span>
        <LanguageSwitcher current={languageChoice} label={languageLabel} />
      </div>
      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <span className="text-sm font-medium text-sand-800">{themeLabel}</span>
        <ThemeToggle label={themeLabel} labels={themeLabels} />
      </div>
      <AssistantSafeSignOutForm action={signOut} locale={locale}>
        <button type="submit" className={menuItemClass()}>
          <SignOutIcon className="text-xl text-sand-500" />
          {signOutLabel}
        </button>
      </AssistantSafeSignOutForm>
    </>
  );

  const avatarMenu = (
    <ActionMenu
      title={profile.name}
      label={`${accountLabel}: ${profile.name}`}
      closeLabel={t("ui.close", locale)}
      triggerLook="bare"
      triggerClassName="focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full hover:bg-sand-100 sm:h-11 sm:w-11"
      trigger={avatar}
    >
      {accountMenuRows}
    </ActionMenu>
  );

  // Footer slot for the "More" sheet: the account page, language, theme and sign-out
  // (the server action stays server-side).
  const signOutSlot = (
    <div className="space-y-2">
      <Link
        href="/account"
        className="focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-base font-medium text-sand-800 hover:bg-sand-100"
      >
        <SettingsIcon className="text-xl text-sand-500" aria-hidden />
        {accountPrefsLabel}
      </Link>
      <div className="flex items-center justify-between gap-3 px-3 py-1">
        <span className="text-base font-medium text-sand-800">{languageLabel}</span>
        <LanguageSwitcher current={languageChoice} label={languageLabel} />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-1">
        <span className="text-base font-medium text-sand-800">{themeLabel}</span>
        <ThemeToggle label={themeLabel} labels={themeLabels} />
      </div>
      <AssistantSafeSignOutForm action={signOut} locale={locale}>
        <button
          type="submit"
          className="focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 text-base font-medium text-sand-800 hover:bg-sand-100"
        >
          <SignOutIcon className="text-xl text-sand-500" />
          {signOutLabel}
        </button>
      </AssistantSafeSignOutForm>
    </div>
  );

  // Everything this role can reach, deduped, handed to the service worker so those
  // screens are there when the signal is not (see WarmRoutes / sw.js).
  const warmPaths = [
    ...new Set(
      [
        ...navItems,
        ...tabItems,
        ...moreItems,
        ...personalItems,
      ].map((i) => i.href),
    ),
  ];

  return (
    <div className="min-h-dvh">
      {/*
        Skip link. There was none, so a keyboard or switch user landed at the top
        of a sidebar carrying up to 24 links and had to traverse every one of them
        before reaching the content, on every single navigation. Off-screen until
        focused (see `.skip-link` in globals.css), then a real, visible control.
        It is first in the DOM so it is the first thing Tab reaches.
      */}
      <a href="#main" className="skip-link">
        {t("nav.skipToContent", locale)}
      </a>
      <WarmRoutes paths={warmPaths} contextKey={`${profile.id}:${currentFarm || profile.farm_id || ""}`} />
      {supporting ? <SupportBanner farmName={supporting.name} locale={locale} /> : null}

      {/* ---- Desktop sidebar (>=1024px) ---- */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-edge-soft bg-surface shadow-soft lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-4">
          {brandMark}
          <span className="text-lg font-bold tracking-tight text-sand-900">{appName}</span>
        </div>
        {showSwitcher && (
          <div className="px-3 pb-2">
            <SiteSwitcher farms={farms} current={currentFarm} label={switcherLabel} />
          </div>
        )}
        {/*
          `rememberKey`/`revealActive`: this nav is up to 26 destinations and 909px of
          scroll on a 720px laptop. A client-side navigation keeps the offset for free
          because React never unmounts the panel; a HARD load does not, and this is a
          PWA relaunched from a home screen with a service worker serving the document.
          Measured before the fix: scrollTop 909 -> 0 on a full load. `revealActive`
          covers the other half, arriving on /billing from an email link with the
          active row 600px below the fold.

          The vertical padding sits on the `<nav>` and not on the scroller, because a
          sticky child is constrained by the scroll container's PADDING box: `py-2`
          here pinned every group heading 8px down and left a strip above it that rows
          scrolled through in the open. Measured: heading top 8, wanted 0.
        */}
        <ScrollArea
          label={t("nav.menu", locale)}
          className="px-3"
          fadeClassName="from-surface"
          rememberKey="nav-sidebar"
          revealActive
        >
          <nav className="space-y-5 py-2">
            {/*
              One loop over one list. The tail used to be a second, near-identical block
              below this map, which is how the two came to render the same heading markup
              twice and could have drifted apart on the next change.
            */}
            {[...groups, ...tailGroups].map((g) => (
              <div key={g.key} className="space-y-1">
                {/*
                  Sticky, and above the ScrollArea's top fade (`z-10` beats the fade's
                  `z-auto` in the aside's stacking context). Scrolling 900px of nav with
                  no heading in sight is how you lose track of which section you are in.
                  `-mx-3 px-6` bleeds it to the panel edges so rows pass BEHIND it
                  rather than beside it.
                */}
                <p className="sticky top-0 z-10 -mx-3 bg-surface px-6 pb-2 pt-2.5 text-xs font-semibold uppercase tracking-wider text-sand-400">
                  {g.label}
                </p>
                {g.items.map((item) => (
                  <NavLink key={item.href} item={item} variant="sidebar" />
                ))}
              </div>
            ))}
          </nav>
        </ScrollArea>
        {/*
          One account row, not four stacked blocks.

          This footer used to be a Language row, an Appearance row, the person's name
          and a Sign out button, all permanently on screen: ~160px of a 720px sidebar
          spent on two switchers that are pressed roughly never, taken off the nav,
          which is the part with 909px of content and nowhere to put it. They now live
          behind the row that names you, which is where every other product keeps them,
          and the nav gets the height back.
        */}
        <div className="border-t border-edge-soft p-2">
          <ActionMenu
            title={profile.name}
            label={`${accountLabel}: ${profile.name}`}
            closeLabel={t("ui.close", locale)}
            triggerLook="bare"
            triggerClassName="focus-ring flex min-h-[48px] w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken"
            trigger={
              <>
                {avatar}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-sand-900">
                    {profile.name}
                  </span>
                  {/* The role in words, at the selected farm. It printed the raw enum
                      ("Rr_admin", "Workshop"), in English for an Afrikaans user. */}
                  <span className="block truncate text-xs text-sand-500">
                    {roleLabel(currentRole ?? profile.role, locale)}
                  </span>
                </span>
                <ChevronUpIcon className="shrink-0 text-lg text-sand-400" />
              </>
            }
          >
            {accountMenuRows}
          </ActionMenu>
        </div>
      </aside>

      {/* ---- Content column ---- */}
      <div className="flex min-h-dvh flex-col lg:pl-64">
        {/*
          Mobile header. ONE sticky row: the multi-farm switcher used to be a second
          sticky row under it at a hard-coded `top-[57px]` (stale once the controls grew
          to 48px, so it tucked under the header on scroll), taking about 65px of every
          phone screen. It is now the farm chip beside the brand mark. See the width
          budget above `bellLink`: nothing here can push the page past 360px.
        */}
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-sand-200 bg-surface/95 px-4 py-1 backdrop-blur lg:hidden">
          <Link
            href={logoHref}
            aria-label={appName}
            className={`focus-ring flex min-h-[48px] items-center gap-2 rounded-lg ${showSwitcher ? "shrink-0" : "min-w-0"}`}
          >
            {brandMark}
            {showSwitcher ? null : (
              // The wordmark only where there is room for it; the mark is the home link.
              <span className="hidden min-w-0 truncate text-lg font-bold tracking-tight text-sand-900 min-[400px]:inline">
                {appName}
              </span>
            )}
          </Link>
          {showSwitcher ? (
            <SiteSwitcherChip
              farms={farms}
              current={currentFarm}
              label={switcherLabel}
              closeLabel={t("ui.close", locale)}
              className="max-w-[45vw]"
            />
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <SearchButton label={t("command.trigger", locale)} />
            <SyncStatus locale={locale} />
            {bellLink}
            {avatarMenu}
          </div>
        </header>

        {/*
          Desktop slim top bar. The palette is mounted here ONCE for every width (its
          dialog is portalled, so the phone header's search button opens this instance).
        */}
        <header className="sticky top-0 z-20 hidden items-center justify-between gap-3 border-b border-edge-soft bg-surface/95 px-6 py-2 backdrop-blur lg:flex">
          <CommandPalette
            groups={paletteGroups}
            actions={paletteActions}
            userId={profile.id}
            labels={{
              trigger: t("command.trigger", locale),
              placeholder: t("command.placeholder", locale),
              title: t("command.title", locale),
              empty: t("command.empty", locale),
              hintSelect: t("command.hintSelect", locale),
              hintClose: t("command.hintClose", locale),
              results: t("command.results", locale),
              pages: t("command.pages", locale),
              machines: t("command.machines", locale),
              searching: t("command.searching", locale),
              recent: t("command.recent", locale),
              actions: t("command.actions", locale),
            }}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <SyncStatus locale={locale} />
            {bellLink}
            {avatarMenu}
          </div>
        </header>

        {/* `tabIndex={-1}` so the skip link can actually move focus here; without
            it the browser scrolls but leaves focus back in the nav. */}
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-screen-2xl flex-1 px-4 pb-24 pt-5 focus:outline-none sm:px-6 lg:px-8 lg:pb-10"
        >
          <Tour steps={tourFor(profile.role)} locale={locale} homePath={homeHref} userId={profile.id} />
        {children}
        </main>
      </div>

      {/* ---- Mobile bottom tab bar ---- */}
      <nav
        aria-label={appName}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-sand-200 bg-surface/95 pb-safe backdrop-blur lg:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch gap-1 px-2">
          {tabItems.map((item) => (
            <NavLink key={item.href} item={item} variant="tab" />
          ))}
          {/* The daily action, report a problem, was nowhere in the chrome. It is
              now a permanent green target, not an item buried in "More".
              `?report=1` asks /faults to open its report dialog on arrival. */}
          {!isWorkshop ? (
            <Link
              href="/faults?report=1"
              className="focus-ring flex min-w-[64px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl bg-brand-600 text-white"
              aria-label={t("nav.reportProblemLong", locale)}
            >
              <FaultsIcon className="text-xl" />
              <span className="text-2xs font-semibold leading-none">{t("nav.reportProblem", locale)}</span>
            </Link>
          ) : null}
          <MoreMenu
            label={t("nav.more", locale)}
            title={t("nav.menu", locale)}
            closeLabel={t("ui.close", locale)}
            groups={moreGroups}
            signOutSlot={signOutSlot}
            newLabel={t("nav.moreHasNew", locale)}
          />
        </div>
      </nav>
    </div>
  );
}
