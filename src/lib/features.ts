import "server-only";

import { cache } from "react";

import { farmAllows, type Profile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Features in testing (20261107120000). Rapid Rise turns one on for chosen businesses and
 * releases it to everyone once it has been tested, from /admin/features. Reading one that
 * cannot be read answers "off": a feature in testing should fail closed.
 */
export const FEATURES = ["map", "general_chat"] as const;
export type Feature = (typeof FEATURES)[number];

export const featureOn = cache(async (key: Feature, farmId: string | null): Promise<boolean> => {
  const supabase = await createClient();
  const { data: flag, error } = await supabase.from("feature_flags").select("released").eq("key", key).maybeSingle();
  if (error || !flag) return false;
  if (flag.released) return true;
  if (!farmId) return false;
  const { data, error: accessError } = await supabase
    .from("farm_feature_access")
    .select("key")
    .eq("key", key)
    .eq("farm_id", farmId)
    .maybeSingle();
  return !accessError && !!data;
});

/**
 * Maps, route planning, reported positions and driving paths: the business is on Complete
 * (decision 18, `maps` in src/lib/entitlements.ts) AND the map has been released to it (the
 * `map` readiness flag). Both, on every screen, route and provider call; the database
 * refuses a saved route or a position below Complete as well (20261114090200).
 */
export async function mapsAvailable(farmId: string | null, profile: Profile): Promise<boolean> {
  if (!farmId) return false;
  if (!(await featureOn("map", farmId))) return false;
  return farmAllows(farmId, "maps", profile);
}
