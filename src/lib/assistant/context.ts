import "server-only";

import {
  getProfile,
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
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
  supabase: Awaited<ReturnType<typeof createClient>>;
};

export async function getAssistantContext(): Promise<AssistantContext | null> {
  const profile = await getProfile();
  if (!profile?.active || profile.role === "workshop") return null;
  const farmId = await currentFarmId(profile);
  if (!farmId) return null;
  const role = await effectiveFarmRole(farmId, profile);
  if (!role) return null;

  if (profile.role !== "rr_admin") {
    const plan = await getFarmPlan(farmId);
    if (!planAllows(plan, "voice_ai")) return null;
  }

  return { profile, farmId, role, supabase: await createClient() };
}
