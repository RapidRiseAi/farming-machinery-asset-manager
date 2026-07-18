"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

/** Mark a watch item done or dismissed (Scope §4.4 "watch items"). */
export async function setWatchStatus(formData: FormData) {
  await requireRole(["owner", "manager", "mechanic"]);
  const id = String(formData.get("id") ?? "");
  const machineId = String(formData.get("machine_id") ?? "");
  const statusRaw = String(formData.get("status") ?? "done");
  const status = ["done", "dismissed"].includes(statusRaw) ? statusRaw : "done";
  const supabase = await createClient();
  await supabase.from("watch_items").update({ status }).eq("id", id);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}?saved=watch`);
}
