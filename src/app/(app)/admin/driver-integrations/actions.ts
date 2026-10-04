"use server";
import { randomBytes, createHash } from "node:crypto";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function configureConnection(
  _previous: { token?: string; error?: boolean; saved?: boolean },
  form: FormData,
): Promise<{ id?: string; token?: string; error?: boolean; saved?: boolean }> {
  await requireRole(["rr_admin"]);
  const db = await createClient();
  const id = String(form.get("id") ?? "");
  const token =
    !id || form.get("rotate") === "on" ? randomBytes(32).toString("hex") : null;
  const { data, error } = await db.rpc("configure_driver_connection", {
    p_farm: String(form.get("farm") ?? ""),
    p_name: String(form.get("name") ?? "").trim(),
    p_kind: String(form.get("kind") ?? ""),
    p_id: id || null,
    p_active: form.get("active") === "on",
    p_quote: String(form.get("quote") ?? "").trim() || null,
    p_hash: token ? createHash("sha256").update(token).digest("hex") : null,
  });
  if (error) return { error: true };
  revalidatePath("/admin/driver-integrations");
  return { id: data, saved: true, ...(token ? { token } : {}) };
}
export async function linkDevice(form: FormData) {
  await requireRole(["rr_admin"]);
  const db = await createClient();
  const { error } = await db.rpc("link_driver_device", {
    p_connection: String(form.get("connection") ?? ""),
    p_external: String(form.get("external") ?? "").trim(),
    p_machine: String(form.get("machine") ?? "") || null,
    p_driver: String(form.get("driver") ?? "") || null,
  });
  revalidatePath("/admin/driver-integrations");
  redirect(
    `/admin/driver-integrations?farm=${encodeURIComponent(String(form.get("farm") ?? ""))}&${error ? "error=1" : "saved=1"}`,
  );
}
