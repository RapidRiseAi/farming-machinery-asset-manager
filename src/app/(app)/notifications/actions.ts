"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";

export async function markRead(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase.from("notifications").update({ status: "delivered" }).eq("id", id).eq("user_id", profile.id);
  revalidatePath("/notifications");
  redirect("/notifications");
}

export async function markAllRead() {
  const profile = await requireProfile();
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ status: "delivered" })
    .eq("user_id", profile.id)
    .eq("status", "queued");
  revalidatePath("/notifications");
  redirect("/notifications");
}
