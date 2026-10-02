"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireFarmRole } from "@/lib/auth";
import { workTransitions } from "@/lib/work-lifecycle";

// The activity inbox is the owner/manager cockpit, only they act on quotes/invoices.
const OWNERS = ["owner", "manager"] as const;

/** Advance a work request + append a lifecycle event (shared by accept/approve below). */
async function advance(id: string, to: "accepted" | "closed", noteKey: string) {
  const profile = await requireRole([...OWNERS]);
  const supabase = await createClient();
  const { data } = await supabase
    .from("work_requests")
    .select("farm_id, status, workshop_id, job_card_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  const row = data as { farm_id: string; status: string; workshop_id: string | null; job_card_id: string | null } | null;
  if (!row) redirect("/inbox?error=Not+found");
  const { role } = await requireFarmRole(row.farm_id, OWNERS, "/inbox?error=forbidden", profile);
  if (!workTransitions(row.status, role, !!row.workshop_id).includes(to)) redirect("/inbox?error=work-transition");
  if (to === "accepted") {
    const { data: quotes, error } = await supabase.from("partner_documents").select("id")
      .eq("work_request_id", id).eq("kind", "quote").eq("status", "sent").is("deleted_at", null).limit(1);
    if (error) redirect(`/inbox?error=${encodeURIComponent(error.message)}`);
    if (quotes?.[0]) redirect(`/documents/${quotes[0].id}`);
  }
  const { error } = await supabase.rpc("update_work_request", {
    p_request: id, p_status: to, p_note: noteKey,
  });
  if (error) redirect(`/inbox?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/inbox");
  revalidatePath(`/work/${id}`);
  revalidatePath("/work");
  revalidatePath("/contractor");
  if (row.job_card_id) revalidatePath(`/jobcards/${row.job_card_id}`);
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
