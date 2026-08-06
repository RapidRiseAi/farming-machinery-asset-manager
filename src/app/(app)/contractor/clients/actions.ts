"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireRole } from "@/lib/auth";

/**
 * A partner's own client book, and the road from it to a real FleetWise farm (F15).
 *
 * Everything here is scoped to the caller's own workshop by RLS (0390), so no action
 * needs to prove which workshop it is acting for — the database will not let it act for
 * another one. The interesting parts are the two that cross the tenant boundary:
 *
 *   requestClientLink — raises a PENDING workshop_link. That grants nothing:
 *     `app.has_farm_access` counts only 'active', and only the farm's own owner/manager
 *     can promote it. It also never tells the partner whether the customer has a
 *     FleetWise account, because "does this address have an account here" is not a
 *     question any partner should be able to ask of the whole customer base. The reply
 *     is the same either way.
 *
 *   syncClientVehicles — copies the partner's notebook vehicles into the now-linked
 *     farm's real fleet. Runs through the RLS client, so it succeeds only because the
 *     link is active; a revoked partner writing to a farm they no longer serve is
 *     rejected by the same policy that governs every other machine insert.
 */

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}

async function ownWorkshopId(): Promise<string> {
  const profile = await requireRole(["workshop"]);
  if (!profile.workshop_id) redirect("/contractor?error=no-workshop");
  return profile.workshop_id;
}

// ── The book ─────────────────────────────────────────────────────────────────

export async function createClientRecord(formData: FormData) {
  const workshopId = await ownWorkshopId();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/contractor/clients?error=need-name");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("partner_clients")
    .insert({
      workshop_id: workshopId,
      name,
      contact_name: s(formData, "contact_name"),
      phone: s(formData, "phone"),
      whatsapp: s(formData, "whatsapp"),
      email: s(formData, "email"),
      address: s(formData, "address"),
      notes: s(formData, "notes"),
    })
    .select("id")
    .single();

  if (error) redirect(`/contractor/clients?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/contractor/clients");
  redirect(`/contractor/clients/${(data as { id: string }).id}`);
}

export async function updateClientRecord(formData: FormData) {
  await ownWorkshopId();
  const id = String(formData.get("client_id") ?? "");
  const supabase = await createClient();

  const { error } = await supabase
    .from("partner_clients")
    .update({
      name: String(formData.get("name") ?? "").trim() || undefined,
      contact_name: s(formData, "contact_name"),
      phone: s(formData, "phone"),
      whatsapp: s(formData, "whatsapp"),
      email: s(formData, "email"),
      address: s(formData, "address"),
      notes: s(formData, "notes"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) redirect(`/contractor/clients/${id}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/contractor/clients/${id}`);
  redirect(`/contractor/clients/${id}?saved=1`);
}

export async function removeClientRecord(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const id = String(formData.get("client_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("partner_clients")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  revalidatePath("/contractor/clients");
  redirect("/contractor/clients?removed=1");
}

// ── The notebook vehicles ────────────────────────────────────────────────────

export async function addClientVehicle(formData: FormData) {
  const workshopId = await ownWorkshopId();
  const clientId = String(formData.get("client_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!clientId || !name) redirect(`/contractor/clients/${clientId}?error=need-name`);

  const yearRaw = Number.parseInt(String(formData.get("year") ?? ""), 10);
  const supabase = await createClient();
  const { error } = await supabase.from("partner_client_vehicles").insert({
    workshop_id: workshopId,
    client_id: clientId,
    name,
    make: s(formData, "make"),
    model: s(formData, "model"),
    reg_no: s(formData, "reg_no"),
    serial_no: s(formData, "serial_no"),
    year: Number.isFinite(yearRaw) && yearRaw > 1900 && yearRaw < 2200 ? yearRaw : null,
    notes: s(formData, "notes"),
  });

  if (error) redirect(`/contractor/clients/${clientId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/contractor/clients/${clientId}`);
  redirect(`/contractor/clients/${clientId}?added=1`);
}

export async function removeClientVehicle(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const clientId = String(formData.get("client_id") ?? "");
  const vehicleId = String(formData.get("vehicle_id") ?? "");
  const supabase = await createClient();
  await supabase
    .from("partner_client_vehicles")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", vehicleId)
    .eq("client_id", clientId);
  revalidatePath(`/contractor/clients/${clientId}`);
  redirect(`/contractor/clients/${clientId}`);
}

// ── Connect ──────────────────────────────────────────────────────────────────

/**
 * Ask a client to connect their FleetWise farm to this partner.
 *
 * If the email belongs to a farm owner/manager, this raises a PENDING `workshop_link`
 * that appears on their Partners screen for approval. If it does not, nothing is raised
 * and the partner is given a sign-up link to share. **The partner sees the same
 * confirmation in both cases** — deliberately, so this cannot be used to test whether an
 * address has an account.
 *
 * The lookup runs under the service role because a partner has no business reading the
 * user table; the only thing that escapes it is a pending request, which grants nothing.
 */
export async function requestClientLink(formData: FormData) {
  const workshopId = await ownWorkshopId();
  const clientId = String(formData.get("client_id") ?? "");
  const supabase = await createClient();

  const { data: clientData } = await supabase
    .from("partner_clients")
    .select("id, email, farm_id, link_status")
    .eq("id", clientId)
    .maybeSingle();
  const client = clientData as { id: string; email: string | null; farm_id: string | null; link_status: string } | null;
  if (!client) redirect("/contractor/clients?error=not-found");
  if (client.farm_id) redirect(`/contractor/clients/${clientId}?error=already-linked`);

  const email = (client.email ?? "").trim().toLowerCase();
  if (!email) redirect(`/contractor/clients/${clientId}?error=need-email`);

  const svc = createServiceClient();
  const { data: userData } = await svc
    .from("users")
    .select("farm_id, role")
    .ilike("email", email)
    .in("role", ["owner", "manager"])
    .eq("active", true)
    .is("deleted_at", null)
    .limit(1);

  const match = ((userData ?? []) as { farm_id: string | null }[])[0];

  if (match?.farm_id) {
    // A pending link. `has_farm_access` ignores pending, so this grants nothing until
    // the farm's owner or manager approves it on their Partners screen.
    const { error } = await supabase
      .from("workshop_links")
      .upsert(
        { workshop_id: workshopId, farm_id: match.farm_id, status: "pending" },
        { onConflict: "workshop_id,farm_id", ignoreDuplicates: true },
      );
    if (!error) {
      await supabase
        .from("partner_clients")
        .update({ link_status: "requested", requested_at: new Date().toISOString() })
        .eq("id", clientId);
    }
  } else {
    // Not on FleetWise (or not an owner/manager). Record that we asked, so the partner's
    // own list shows they have chased it, and hand them a link to share.
    await supabase
      .from("partner_clients")
      .update({ link_status: "requested", requested_at: new Date().toISOString() })
      .eq("id", clientId);
  }

  revalidatePath(`/contractor/clients/${clientId}`);
  // Same destination either way — the partner is not told which branch ran.
  redirect(`/contractor/clients/${clientId}?asked=1`);
}

/**
 * Copy this client's notebook vehicles into the linked farm's real fleet.
 *
 * Only offered once the link is ACTIVE, and only once — `synced_at` closes the offer, so
 * pressing twice cannot duplicate a fleet. Each copied row records the `machine_id` it
 * became, so the notebook entry and the real asset stay traceable to each other.
 *
 * Written through the RLS client on purpose: it succeeds because the partner currently
 * has access to that farm, and stops succeeding the moment that access is revoked.
 */
export async function syncClientVehicles(formData: FormData) {
  const profile = await requireRole(["workshop"]);
  const clientId = String(formData.get("client_id") ?? "");
  const supabase = await createClient();

  const { data: clientData } = await supabase
    .from("partner_clients")
    .select("id, farm_id, synced_at")
    .eq("id", clientId)
    .maybeSingle();
  const client = clientData as { id: string; farm_id: string | null; synced_at: string | null } | null;
  if (!client?.farm_id) redirect(`/contractor/clients/${clientId}?error=not-linked`);
  if (client.synced_at) redirect(`/contractor/clients/${clientId}?error=already-synced`);

  const { data: vData } = await supabase
    .from("partner_client_vehicles")
    .select("id, name, make, model, reg_no, serial_no, year, notes")
    .eq("client_id", clientId)
    .is("machine_id", null)
    .is("deleted_at", null);

  const vehicles = (vData ?? []) as {
    id: string; name: string; make: string | null; model: string | null;
    reg_no: string | null; serial_no: string | null; year: number | null; notes: string | null;
  }[];

  let copied = 0;
  for (const v of vehicles) {
    const { data: created, error } = await supabase
      .from("machines")
      .insert({
        farm_id: client.farm_id,
        name: v.name,
        // The notebook does not ask for a machine type, and guessing one from a
        // free-text make would put a wrong label on someone's asset. `atv_other` is the
        // catch-all the enum already has; the farm corrects it in one tap.
        type: "atv_other",
        make: v.make,
        model: v.model,
        reg_no: v.reg_no,
        serial_no: v.serial_no,
        year: v.year,
        notes: v.notes,
        status: "active",
        created_by: profile.id,
      })
      .select("id")
      .single();

    if (error || !created) continue;
    await supabase
      .from("partner_client_vehicles")
      .update({ machine_id: (created as { id: string }).id })
      .eq("id", v.id);
    copied += 1;
  }

  await supabase
    .from("partner_clients")
    .update({ synced_at: new Date().toISOString() })
    .eq("id", clientId);

  revalidatePath(`/contractor/clients/${clientId}`);
  revalidatePath("/machines");
  redirect(`/contractor/clients/${clientId}?synced=${copied}`);
}
