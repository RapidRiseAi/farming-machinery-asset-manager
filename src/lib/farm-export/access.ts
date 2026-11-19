import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { accessibleFarms, currentFarmId, effectiveFarmRole, getProfile } from "@/lib/auth";
import { farmLifecycle } from "@/lib/billing/service";
import { exportRefusal } from "@/lib/farm-export-policy";
import { isUuid } from "@/lib/ids";
import { createClient } from "@/lib/supabase/server";

export type ExportAccess =
  | { ok: true; userId: string; farmId: string; role: string; session: SupabaseClient }
  | { ok: false; response: NextResponse };

const refuse = (error: string, status: number): ExportAccess => ({
  ok: false,
  response: NextResponse.json({ error }, { status, headers: { "cache-control": "no-store, private" } }),
});

/**
 * Who may export which business, the same rule as the streamed export and the file download:
 * a business the person reaches, as its owner or manager (or Rapid Rise), and the lifecycle's
 * own gate (owner only during the 90 days, nobody after them). Answers in JSON, never a redirect
 * to a login page saved as an export.
 */
export async function exportAccess(asked: string | null): Promise<ExportAccess> {
  const profile = await getProfile();
  if (!profile || !profile.active) return refuse("auth", 401);
  const farmId = isUuid(asked) && (await accessibleFarms(profile)).some((f) => f.id === asked)
    ? asked
    : await currentFarmId(profile);
  if (!farmId) return refuse("no-farm", 403);
  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "manager" && role !== "rr_admin") return refuse("forbidden", 403);
  const session = await createClient();
  const lifecycle = role === "rr_admin" ? null : await farmLifecycle(session, farmId);
  const refusal = exportRefusal(role, lifecycle?.gate ?? null, lifecycle);
  if (refusal) return refuse(refusal.error, refusal.status);
  return { ok: true, userId: profile.id, farmId, role, session };
}

export const NO_STORE = { "cache-control": "no-store, private" } as const;
