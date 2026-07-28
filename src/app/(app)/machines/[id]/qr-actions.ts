"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

/**
 * Re-issue (rotate) a machine's public QR token (FR-9.4).
 *
 * Generating a fresh unguessable `public_token` immediately invalidates any
 * previously printed QR sticker for this machine — the old `/m/<token>` link
 * (and every service-role token lookup behind it) stops resolving, so a lost,
 * damaged, or possibly-copied sticker can be retired and reprinted.
 *
 * Owner/manager only (rr_admin may act cross-tenant); the guard is enforced HERE,
 * not merely in the UI. The UPDATE runs through the RLS server client and is scoped
 * by `id` alone — RLS (`app.has_farm_access`) limits it to the caller's own farm's
 * machines, and the `machines` audit trigger logs the token change automatically.
 * `crypto.randomUUID()` yields a v4 uuid the `public_token uuid` column accepts.
 */
export async function reissueQr(formData: FormData) {
  await requireRole(["owner", "manager", "rr_admin"]);
  const machineId = String(formData.get("machine_id") ?? "");
  if (!machineId) redirect("/machines");

  const supabase = await createClient();
  const { error } = await supabase
    .from("machines")
    .update({ public_token: crypto.randomUUID() })
    .eq("id", machineId);
  if (error) redirect(`/machines/${machineId}/qr?error=${encodeURIComponent(error.message)}`);

  // Refresh the QR sheet (new code) and the machine detail (any cached token).
  revalidatePath(`/machines/${machineId}/qr`);
  revalidatePath(`/machines/${machineId}`);
  redirect(`/machines/${machineId}/qr?reissued=1`);
}
