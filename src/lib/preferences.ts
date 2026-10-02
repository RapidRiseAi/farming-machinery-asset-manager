/**
 * Personal preferences that live on the DEVICE rather than on the profile: which screen
 * the app opens on (`fw_start`) and which screens sit in the phone's bottom bar
 * (`fw_tabs`).
 *
 * == Why cookies and not columns ==============================================
 * No migration, and both are genuinely per device: the phone in the cab and the laptop
 * in the office are used for different things. The account page says "on this device"
 * next to both so nobody expects them to follow them to another screen.
 *
 * == Why every read is validated ===============================================
 * A cookie is whatever the browser sends. A role can change (a mechanic made an
 * operator), a plan can drop, and a hand-edited cookie can say anything. So the stored
 * value is only ever used when it is still one of the destinations this person can open
 * today; otherwise the caller falls back to the role's standard screen. The same list
 * drives the choices on /account, so the page can never offer what the reader rejects.
 *
 * Plain module (no "use server", no "use client") so the account page, its actions,
 * /home, the app shell and the tests can all import it.
 */

import type { Role } from "./auth";
import { planAllows, type Plan } from "./entitlements";

export const START_COOKIE = "fw_start";
export const TABS_COOKIE = "fw_tabs";
/**
 * The most shortcuts anyone can pin. The phone bar holds five slots: its first tab (the
 * role's standard home, always there), your own, and More, plus the green Report button
 * on every bar except a partner's. So a partner has room for three and everyone else for
 * two; `maxTabsFor` says which. Six slots at 360px truncated every label.
 */
export const MAX_TABS = 3;
/** A year: long enough to be a setting, short enough to expire on a lost phone. */
export const PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type Destination = {
  href: string;
  /** i18n key for its name, the same key the navigation uses. */
  labelKey: string;
  /** Icon name in the kit's `iconByName`, matching the navigation's item. */
  icon: string;
};

const D = {
  dashboard: { href: "/dashboard", labelKey: "nav.dashboard", icon: "dashboard" },
  driverHome: { href: "/driver", labelKey: "nav.driverHome", icon: "dashboard" },
  contractor: { href: "/contractor", labelKey: "nav.contractor", icon: "dashboard" },
  clients: { href: "/contractor/clients", labelKey: "nav.clients", icon: "team" },
  inbox: { href: "/inbox", labelKey: "nav.inbox", icon: "inbox" },
  machines: { href: "/machines", labelKey: "nav.machines", icon: "machines" },
  jobcards: { href: "/jobcards", labelKey: "nav.jobcards", icon: "jobcards" },
  faults: { href: "/faults", labelKey: "nav.faults", icon: "faults" },
  work: { href: "/work", labelKey: "nav.work", icon: "work" },
  documents: { href: "/documents", labelKey: "nav.documents", icon: "documents" },
  fuel: { href: "/fuel", labelKey: "nav.fuel", icon: "fuel" },
  parts: { href: "/parts", labelKey: "nav.parts", icon: "parts" },
  checklists: { href: "/checklists", labelKey: "nav.checklists", icon: "checklists" },
  calendar: { href: "/calendar", labelKey: "nav.calendar", icon: "calendar" },
  reports: { href: "/reports", labelKey: "nav.reports", icon: "reports" },
  alerts: { href: "/notifications", labelKey: "nav.notifications", icon: "bell" },
  admin: { href: "/admin/farms", labelKey: "nav.admin", icon: "admin" },
} satisfies Record<string, Destination>;

/**
 * The screens this person can choose to start on or pin to the phone bar.
 *
 * Deliberately a short, safe list rather than the whole navigation: every entry is a
 * screen the role can open on any farm it belongs to, and the plan-gated ones are
 * dropped when the plan does not unlock them. `plan` null means the role is not
 * plan-gated (Rapid Rise staff, partners), the same reading the app shell uses.
 */
export function destinationsFor(role: Role, plan: Plan | null): Destination[] {
  const has = (f: Parameters<typeof planAllows>[1]) => plan == null || planAllows(plan, f);
  switch (role) {
    case "rr_admin":
      return [D.admin, D.alerts];
    case "workshop":
      return [D.contractor, D.clients, D.work, D.documents, D.jobcards, D.machines, D.alerts];
    case "operator":
      // Fuel is on a driver's standard bar when the plan has it, so it must stay
      // pinnable, or choosing shortcuts would silently take it away.
      return [D.driverHome, D.machines, ...(has("fuel") ? [D.fuel] : []), D.faults, D.checklists, D.alerts];
    case "mechanic":
      return [
        ...(has("dashboard") ? [D.dashboard] : []),
        D.machines,
        D.jobcards,
        D.faults,
        D.work,
        D.parts,
        D.checklists,
        D.calendar,
        D.alerts,
      ];
    default:
      // owner, manager
      return [
        ...(has("dashboard") ? [D.dashboard] : []),
        D.inbox,
        D.machines,
        D.jobcards,
        D.faults,
        D.work,
        D.documents,
        ...(has("fuel") ? [D.fuel] : []),
        D.parts,
        D.checklists,
        D.calendar,
        ...(has("advanced_reports") ? [D.reports] : []),
        D.alerts,
      ];
  }
}

/**
 * The role's standard first screen on this plan: the phone bar's first tab, and where the
 * logo goes when no start page has been chosen. Unlike `homePathFor` (where /home sends a
 * person with no choice), it never names a screen the plan does not unlock: a farm without
 * the dashboard starts on its machines.
 */
export function standardHomeFor(role: Role, plan: Plan | null): string {
  if (role === "workshop") return "/contractor";
  if (role === "operator") return "/driver";
  return plan == null || planAllows(plan, "dashboard") ? "/dashboard" : "/machines";
}

/** How many shortcuts this role's phone bar has room for (see `MAX_TABS`). */
export function maxTabsFor(role: Role): number {
  return role === "workshop" ? MAX_TABS : MAX_TABS - 1;
}

/**
 * The screens that can be pinned to the phone bar: every destination except the bar's own
 * first tab, which is always there, so a pin is never spent on it. The /account picker,
 * its save action and the app shell all read pins through this one list.
 */
export function pinnableDestinations(role: Role, plan: Plan | null): Destination[] {
  const home = standardHomeFor(role, plan);
  return destinationsFor(role, plan).filter((d) => d.href !== home);
}

/**
 * The start page to use: the stored choice while it is still allowed, else `fallback`
 * (the role's standard home, `homePathFor(role)`).
 */
export function resolveStartPath(
  stored: string | null | undefined,
  allowed: readonly Destination[],
  fallback: string,
): string {
  const v = (stored ?? "").trim();
  return v && allowed.some((d) => d.href === v) ? v : fallback;
}

/**
 * The phone shortcuts to use: the stored hrefs that are still allowed, in the stored
 * order, without repeats, at most `max` (pass `maxTabsFor(role)`; never above
 * `MAX_TABS`). An empty result means "the standard set", which the shell builds itself.
 *
 * `setPhoneShortcuts` writes the cookie as comma-separated hrefs. Next encodes the value
 * on the way out and `cookies().get()` decodes it on the way in, so this sees the commas.
 */
export function parseTabs(
  stored: string | null | undefined,
  allowed: readonly Destination[],
  max: number = MAX_TABS,
): string[] {
  const cap = Math.max(0, Math.min(max, MAX_TABS));
  const ok = new Set(allowed.map((d) => d.href));
  const out: string[] = [];
  for (const raw of String(stored ?? "").split(",")) {
    if (out.length >= cap) break;
    const href = raw.trim();
    if (!href || !ok.has(href) || out.includes(href)) continue;
    out.push(href);
  }
  return out;
}

/** The label key for a stored href, for stating the choice back on /account. */
export function destinationLabelKey(href: string, allowed: readonly Destination[]): string | null {
  return allowed.find((d) => d.href === href)?.labelKey ?? null;
}
