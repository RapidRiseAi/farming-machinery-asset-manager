"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";

/** Mark one in-app alert read (read_at is the read marker; 0205). */
export async function markRead(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("user_id", profile.id).is("read_at", null);
  revalidatePath("/notifications");
  redirect("/notifications");
}

export async function markAllRead() {
  const profile = await requireProfile();
  const supabase = await createClient();
  await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", profile.id).is("read_at", null);
  revalidatePath("/notifications");
  redirect("/notifications");
}
