import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type Role =
  | "rr_admin"
  | "owner"
  | "manager"
  | "mechanic"
  | "workshop"
  | "operator";

export type Profile = {
  id: string;
  farm_id: string | null;
  workshop_id: string | null;
  role: Role;
  name: string;
  email: string | null;
  language: "en" | "af";
  active: boolean;
};

const PROFILE_COLUMNS =
  "id, farm_id, workshop_id, role, name, email, language, active";

/** The authenticated Supabase auth user, or null. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

/** The current user's app profile row (public.users), or null. */
export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("id", uid)
    .maybeSingle();
  return (data as Profile | null) ?? null;
}

/** Redirect to /login unless authenticated. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Require an active app profile. A logged-in auth user with no profile row (or a
 * deactivated one) is sent back to /login — profiles are created via invites.
 */
export async function requireProfile(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile || !profile.active) redirect("/login?error=no-profile");
  return profile;
}

/** Require the profile to hold one of `roles`, else bounce to the dashboard. */
export async function requireRole(roles: Role[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) redirect("/dashboard?error=forbidden");
  return profile;
}
