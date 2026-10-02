/**
 * Which dashboard sections a person has chosen to see, on this device.
 *
 * == Why a cookie and not a column ============================================
 * A per-user preferences column needs a migration and a decision about role defaults
 * that belongs to the farm owner. A cookie needs neither: the server page reads it, the
 * "Customise" dialog writes it, and the worst a stale or tampered value can do is hide a
 * card from the person who set it. Nothing in here is a permission. A hidden card is a
 * choice about clutter; what a role may SEE is still decided by the queries and RLS.
 *
 * "Needs your attention" is not listed on purpose: it is the reason the page exists, and
 * hiding it would turn the dashboard into a page that says nothing.
 *
 * == Format ===================================================================
 * `cost=0,fuel=1`, known keys only. Anything unrecognised is ignored, and anything the
 * cookie does not mention falls back to the role default, so adding a section later
 * never hides it from people who customised before it existed.
 */

export const DASH_COOKIE = "fw_dash";

export const DASH_SECTIONS = ["setup", "cost", "fleet", "fuel", "stale"] as const;
export type DashSection = (typeof DASH_SECTIONS)[number];
export type DashPrefs = Record<DashSection, boolean>;

/**
 * What a role sees before choosing. A mechanic lands here too, and the fleet's running
 * cost is the owner's question, not theirs, so it starts hidden for them (and they can
 * switch it back on; whether they may see costs at all is still `canViewFarmCosts`).
 */
export function defaultDashPrefs(role: string | null | undefined): DashPrefs {
  return {
    setup: true,
    cost: role !== "mechanic",
    fleet: true,
    fuel: true,
    stale: true,
  };
}

export function parseDashPrefs(raw: string | null | undefined, role: string | null | undefined): DashPrefs {
  const prefs = defaultDashPrefs(role);
  if (!raw) return prefs;
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=");
    if ((DASH_SECTIONS as readonly string[]).includes(k) && (v === "0" || v === "1")) {
      prefs[k as DashSection] = v === "1";
    }
  }
  return prefs;
}

export function serializeDashPrefs(prefs: DashPrefs): string {
  return DASH_SECTIONS.map((k) => `${k}=${prefs[k] ? 1 : 0}`).join(",");
}
