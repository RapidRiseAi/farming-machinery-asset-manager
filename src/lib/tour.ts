import type { Role } from "@/lib/auth";

/**
 * The guided walkthrough.
 *
 * Deliberately NOT a spotlight-on-the-DOM tour. Those break the moment a screen
 * changes, they cannot survive a page navigation, and on a phone they cover the thing
 * they are pointing at. This is a short sequence of cards, each one about a real screen
 * and each ending on a link that takes you to it — so the tour is a set of destinations,
 * not a puppet show, and it works the same whether someone finishes it in one sitting or
 * comes back to it a week later.
 *
 * Role-aware, because the product genuinely differs: a driver has four things to do and
 * no money screens, a contractor lives in a different shell entirely, and only an
 * owner/manager sees the setup steps.
 *
 * Step content lives in i18n under `tour.<id>Title` / `<id>Body`, so both languages and
 * both tones flow through the normal `t()` path.
 */
export type TourStep = {
  id: string;
  /** Where "Show me" goes. Null for a step that is purely explanatory. */
  href: string | null;
  /** Nav/icon name so each card carries the same glyph the nav does. */
  icon: string;
};

const OWNER: TourStep[] = [
  { id: "welcome", href: null, icon: "dashboard" },
  { id: "machines", href: "/machines", icon: "machines" },
  { id: "qr", href: "/machines", icon: "machines" },
  { id: "faults", href: "/faults", icon: "faults" },
  { id: "jobcards", href: "/jobcards", icon: "jobcards" },
  { id: "money", href: "/reports", icon: "reports" },
  { id: "install", href: "/install", icon: "download" },
  { id: "help", href: null, icon: "info" },
];

const MECHANIC: TourStep[] = [
  { id: "welcome", href: null, icon: "dashboard" },
  { id: "machines", href: "/machines", icon: "machines" },
  { id: "faults", href: "/faults", icon: "faults" },
  { id: "jobcards", href: "/jobcards", icon: "jobcards" },
  { id: "install", href: "/install", icon: "download" },
  { id: "help", href: null, icon: "info" },
];

const DRIVER: TourStep[] = [
  { id: "driverWelcome", href: null, icon: "dashboard" },
  { id: "driverScan", href: "/driver", icon: "machines" },
  { id: "driverFault", href: "/faults", icon: "faults" },
  { id: "driverHours", href: "/driver", icon: "machines" },
  { id: "install", href: "/install", icon: "download" },
  { id: "help", href: null, icon: "info" },
];

const CONTRACTOR: TourStep[] = [
  { id: "contractorWelcome", href: null, icon: "dashboard" },
  { id: "contractorWork", href: "/work", icon: "work" },
  { id: "contractorQuote", href: "/work", icon: "work" },
  { id: "install", href: "/install", icon: "download" },
  { id: "help", href: null, icon: "info" },
];

export function tourFor(role: Role): TourStep[] {
  switch (role) {
    case "operator":
      return DRIVER;
    case "workshop":
      return CONTRACTOR;
    case "mechanic":
      return MECHANIC;
    default:
      return OWNER;
  }
}

/**
 * Where the "seen it" flag lives.
 *
 * localStorage, not the database: finishing a tour is not farm data, it is a property
 * of this person on this device, and it must not cost a write or a migration. The
 * `farmgear:` prefix is kept for continuity with the other keys already in storage.
 */
export const TOUR_SEEN_KEY = "farmgear:tour-done";
export const TOUR_STEP_KEY = "farmgear:tour-step";
