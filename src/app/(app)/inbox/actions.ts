"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";

// The activity inbox is the owner/manager cockpit, only they act on quotes/invoices.
const OWNERS = ["owner", "manager"] as const;

/** Advance a work request + append a lifecycle event (shared by accept/approve below). */
async function advance(id: string, to: "accepted" | "closed", noteKey: string) {
  const profile = await requireRole([...OWNERS]);
  const supabase = await createClient();
  const { data } = await supabase
    .from("work_requests")
    .select("farm_id, status")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as { farm_id: string; status: string } | null;
  if (!row) redirect("/inbox?error=Not+found");

  const { error } = await supabase
    .from("work_requests")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) redirect(`/inbox?error=${encodeURIComponent(error.message)}`);

  await supabase.from("work_request_events").insert({
    farm_id: row.farm_id,
    work_request_id: id,
    from_status: row.status,
    to_status: to,
    note: noteKey,
    by_user: profile.id,
  });
  revalidatePath("/inbox");
  revalidatePath(`/work/${id}`);
}

/** Owner accepts a contractor's quote → the request moves to `accepted`. */
export async function acceptQuote(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/inbox");
  await advance(id, "accepted", "Quote accepted");
  redirect("/inbox?saved=quote_accepted");
}

/** Owner approves a contractor's invoice → the request is closed off. */
export async function approveInvoice(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/inbox");
  await advance(id, "closed", "Invoice approved");
  redirect("/inbox?saved=invoice_approved");
}

/** Mark one queued alert read (read_at is the marker; 0205). Scoped to the caller. */
export async function markInboxRead(formData: FormData) {
  const profile = await requireRole([...OWNERS]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", profile.id)
    .is("read_at", null);
  revalidatePath("/inbox");
  redirect("/inbox");
}

/**
 * Open one alert from the inbox feed: mark it read, then go where it points.
 *
 * The feed used to put a "Read" button on every row beside the link, so opening an alert
 * left it unread and marking it read was a second tap. The destination is worked out here
 * from the stored row, never from the form, and only a same-origin path is followed.
 */
export async function openInboxAlert(formData: FormData) {
  const profile = await requireRole([...OWNERS]);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("template, payload")
    .eq("id", id)
    .eq("user_id", profile.id)
    .maybeSingle();
  const row = data as { template: string; payload: Record<string, unknown> | null } | null;
  if (!row) redirect("/inbox");
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", profile.id)
    .is("read_at", null);
  revalidatePath("/inbox");
  // Imported here rather than at the top so this addition stays clear of the import
  // block another in-flight change rewrites.
  const { notificationUrl } = await import("@/lib/notifications/format");
  const href = notificationUrl(row.template, row.payload ?? {});
  redirect(href.startsWith("/") && !href.startsWith("//") && !href.includes("\\") ? href : "/inbox");
}

/** Mark every one of the caller's queued alerts read. */
export async function markAllInboxRead() {
  const profile = await requireRole([...OWNERS]);
  const supabase = await createClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", profile.id)
    .is("read_at", null);
  revalidatePath("/inbox");
  redirect("/inbox");
}
