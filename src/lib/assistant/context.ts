import "server-only";

import {
  getProfile,
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  farmIsUsable,
  type Profile,
  type Role,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
export { sameOrigin } from "@/lib/security/same-origin";

export type AssistantContext = {
  profile: Profile;
  farmId: string;
  role: Role;
  sourceChannel?: "whatsapp";
  supabase: Awaited<ReturnType<typeof createClient>>;
};

/**
 * `allowStoppedFarm`: for the voice meter's usage reports only. A report closes a session
 * already open and only lowers what the nightly sweep would bill for it, so it is accepted
 * after the farm stops; refusing it billed the session at its maximum.
 */
export async function getAssistantContext(opts: { allowStoppedFarm?: boolean } = {}): Promise<AssistantContext | null> {
  const profile = await getProfile();
  if (!profile?.active || profile.role === "workshop") return null;
  const farmId = await currentFarmId(profile);
  if (!farmId) return null;
  const role = await effectiveFarmRole(farmId, profile);
  if (!role) return null;
  // A paused, closed or unpaid farm uses no AI or voice (20261029090100): every assistant
  // route returns its "not available" answer, so no model runs on Rapid Rise's keys.
  if (!opts.allowStoppedFarm && !(await farmIsUsable(farmId, profile))) return null;

  if (profile.role !== "rr_admin") {
    const plan = await getFarmPlan(farmId);
    if (!planAllows(plan, "voice_ai")) return null;
  }

  return { profile, farmId, role, supabase: await createClient() };
}
