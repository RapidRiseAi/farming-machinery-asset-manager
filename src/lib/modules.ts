/**
 * Module switches and simple mode for drivers (launch item H9, founder decision of
 * 13 October 2026: before launch).
 *
 * A farm that does not run a fuel bowser, does not track tyres or has no fines to manage
 * should not have those screens in every menu. An owner or manager switches them off in
 * Settings; they leave the sidebar, the phone tabs, the More sheet and the command palette.
 * Nothing is deleted and nothing is refused: a switched-off module's records stay, its
 * pages still open from a link, and switching it back on brings everything back. This is
 * about a simpler menu, not about access, which stays with roles, plans and RLS.
 *
 * Simple mode is for drivers: their menu becomes the driver home, help and the app
 * install. The home already holds what a driver does (pick the machine, log hours, report
 * a problem, diesel, driver activity), and the green Report button stays on every screen.
 *
 * Both are stored in the farm's settings blob (`farms.settings`), merged by
 * `src/lib/settings.ts`. Every module defaults to ON and simple mode to OFF, so a farm
 * that never opens the setting sees exactly what it saw before.
 */

/** The optional modules, each with the menu destinations it owns. Core screens are not switchable. */
export const FARM_MODULES = {
  fuel: ["/fuel"],
  tyres: ["/tyres"],
  parts: ["/parts"],
  checklists: ["/checklists"],
  incidents: ["/incidents"],
  fines: ["/fines"],
  finance: ["/finance"],
  partners: ["/partners"],
  calendar: ["/calendar"],
  driver_activity: ["/driver/activity"],
} as const;

export type FarmModule = keyof typeof FARM_MODULES;
export const MODULE_KEYS = Object.keys(FARM_MODULES) as FarmModule[];

/** The settings key that switches a module: `module_fuel` and so on, true = on. */
export const moduleSettingKey = (m: FarmModule) => `module_${m}`;

/** The keys `mergeSettings` knows, with their defaults: every module on, simple mode off. */
export const MODULE_SETTING_DEFAULTS: Record<string, boolean> = {
  ...Object.fromEntries(MODULE_KEYS.map((m) => [moduleSettingKey(m), true])),
  simple_driver_mode: false,
};

export function moduleOn(settings: Record<string, unknown> | null | undefined, m: FarmModule): boolean {
  return settings?.[moduleSettingKey(m)] !== false;
}

export function simpleDriverMode(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.simple_driver_mode === true;
}

/** What a driver in simple mode keeps in their menus. */
export const SIMPLE_DRIVER_HREFS = ["/driver", "/help", "/install"] as const;

/**
 * The menu destinations this farm has chosen to leave out, for this person. Rapid Rise
 * staff and workshops are never trimmed: they are not the farm's people, and a contractor
 * works across farms that chose differently.
 */
export function hiddenMenuHrefs(
  settings: Record<string, unknown> | null | undefined,
  who: { isOperator: boolean; isWorkshop: boolean; isAdmin: boolean },
  allHrefs: readonly string[] = [],
): Set<string> {
  const hidden = new Set<string>();
  if (who.isWorkshop || who.isAdmin) return hidden;
  for (const m of MODULE_KEYS) {
    if (!moduleOn(settings, m)) for (const href of FARM_MODULES[m]) hidden.add(href);
  }
  if (who.isOperator && simpleDriverMode(settings)) {
    for (const href of allHrefs) {
      if (!(SIMPLE_DRIVER_HREFS as readonly string[]).includes(href)) hidden.add(href);
    }
  }
  return hidden;
}
