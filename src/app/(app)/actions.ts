"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { CURRENT_FARM_COOKIE, accessibleFarms } from "@/lib/auth";

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

/**
 * Switch the "current farm" a multi-site user is acting in (F7). The chosen id is
 * validated against the farms the user can actually access before it is stored — an
 * invalid choice is ignored (RLS is the real guard, but the cookie stays honest).
 */
export async function setCurrentFarm(formData: FormData) {
  const farmId = String(formData.get("farm_id") ?? "").trim();
  const next = String(formData.get("next") ?? "").trim();
  if (farmId) {
    const farms = await accessibleFarms();
    if (farms.some((f) => f.id === farmId)) {
      const store = await cookies();
      store.set(CURRENT_FARM_COOKIE, farmId, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
  }
  revalidatePath("/", "layout");
  redirect(next && next.startsWith("/") ? next : "/machines");
}
