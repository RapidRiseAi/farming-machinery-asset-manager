import "server-only";

import { redirect } from "next/navigation";
import {
  currentFarmId,
  effectiveFarmRole,
  homePathFor,
  requireProfile,
  type Profile,
  type Role,
} from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * The deliberately closed set from 0507. Keep this list byte-for-byte aligned with
 * `app_user_permission_grants_check`: a switch the database does not enforce would make
 * the team screen promise access that does not exist.
 */
export const USER_PERMISSIONS = [
  "see_all_vehicles",
  "manage_stock",
  "manage_partners",
] as const;

export type UserPermission = (typeof USER_PERMISSIONS)[number];

const BASELINE_ROLES: Record<UserPermission, readonly Role[]> = {
  // Operators are assignment-scoped unless this additive grant opens the whole farm.
  see_all_vehicles: ["rr_admin", "owner", "manager", "mechanic"],
  // Mirrors 0452. RR admins curate the global catalogue; they do not move farm stock.
  manage_stock: ["owner", "manager", "mechanic"],
  // RR admins curate global suggestions; owner/manager maintain a farm's directory.
  manage_partners: ["rr_admin", "owner", "manager"],
};

export function isUserPermission(value: unknown): value is UserPermission {
  return typeof value === "string" && (USER_PERMISSIONS as readonly string[]).includes(value);
}

export function roleHasBaselinePermission(
  role: Role | null,
  permission: UserPermission,
): boolean {
  return role != null && BASELINE_ROLES[permission].includes(role);
}

export type FarmPermissionState = {
  profile: Profile;
  farmId: string | null;
  role: Role | null;
  /** Active additive grants held by the signed-in person on this farm. */
  grants: ReadonlySet<UserPermission>;
  allows: (permission: UserPermission) => boolean;
};

/**
 * Resolve all three app-side permission decisions in one RLS-backed read.
 *
 * The farm is selected server-side from the validated cookie. The role comes from the
 * authoritative membership for that farm, not `users.role` (which describes only the
 * primary farm). `user_permission_grants` remains the security boundary: ordinary users
 * may read only their own active grants; managers may additionally administer their
 * selected farm through its policies.
 */
export async function farmPermissionState(
  profile?: Profile,
  selectedFarmId?: string | null,
): Promise<FarmPermissionState> {
  const p = profile ?? (await requireProfile());
  const farmId = selectedFarmId === undefined ? await currentFarmId(p) : selectedFarmId;
  const role = farmId ? await effectiveFarmRole(farmId, p) : p.role === "rr_admin" ? "rr_admin" : null;
  const grants = new Set<UserPermission>();

  if (farmId && role && role !== "workshop" && role !== "rr_admin") {
    const supabase = await createClient();
    const { data } = await supabase
      .from("user_permission_grants")
      .select("permission")
      .eq("farm_id", farmId)
      .eq("user_id", p.id)
      .is("deleted_at", null);

    for (const row of (data ?? []) as { permission: unknown }[]) {
      if (isUserPermission(row.permission)) grants.add(row.permission);
    }
  }

  const allows = (permission: UserPermission) =>
    roleHasBaselinePermission(role, permission) || grants.has(permission);

  return { profile: p, farmId, role, grants, allows };
}

/**
 * Server-action guard for one of the additive permissions. Returning the resolved farm
 * makes it difficult for a caller to authorize one site and accidentally write another.
 */
export async function requireFarmPermission(
  permission: UserPermission,
  deniedPath?: string,
): Promise<FarmPermissionState & { farmId: string }> {
  const state = await farmPermissionState();
  if (!state.farmId || !state.allows(permission)) {
    redirect(deniedPath ?? `${homePathFor(state.profile.role)}?denied=1`);
  }
  return state as FarmPermissionState & { farmId: string };
}

