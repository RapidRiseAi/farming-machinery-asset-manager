"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireRole } from "@/lib/auth";
import type { Role } from "@/lib/auth";

// Who may maintain the partners directory: a farm's owner/manager for their own rows,
// RR admin for the GLOBAL suggested catalogue. (RLS enforces the same on write.)
const PARTNER_CREW: Role[] = ["owner", "manager", "rr_admin"];

const KINDS = [
  "mechanic", "auto_electrician", "parts_supplier",
  "panel_beater", "tyre", "towing", "other",
] as const;
type Kind = (typeof KINDS)[number];

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? null : v;
}
function kindOf(fd: FormData): Kind {
  const v = String(fd.get("kind") ?? "other");
  return (KINDS as readonly string[]).includes(v) ? (v as Kind) : "other";
}

/** Fields shared by create/update. */
function partnerFields(fd: FormData) {
  return {
    name: s(fd, "name"),
    kind: kindOf(fd),
    phone: s(fd, "phone"),
    whatsapp: s(fd, "whatsapp"),
    email: s(fd, "email"),
    area: s(fd, "area"),
    notes: s(fd, "notes"),
  };
}

export async function createPartner(formData: FormData) {
  const profile = await requireRole(PARTNER_CREW);
  const f = partnerFields(formData);
  if (!f.name) redirect("/partners?error=Name+is+required");

  // RR admin (no farm) curates the GLOBAL suggested catalogue (farm_id null,
  // is_suggested true); a farmer adds a row scoped to their own farm.
  const isAdmin = profile.role === "rr_admin";
  const farmId = isAdmin ? null : profile.farm_id;
  if (!isAdmin && !farmId) redirect("/partners?error=No+farm");

  const supabase = await createClient();
  const { error } = await supabase.from("partners").insert({
    farm_id: farmId,
    is_suggested: isAdmin,
    ...f,
    created_by: profile.id,
  });
  if (error) redirect(`/partners?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/partners");
  redirect("/partners?saved=1");
}

export async function updatePartner(formData: FormData) {
  await requireRole(PARTNER_CREW);
  const id = String(formData.get("id") ?? "");
  const f = partnerFields(formData);
  if (!id || !f.name) redirect("/partners?error=Name+is+required");

  const supabase = await createClient();
  // RLS restricts this to the farm's owner/manager (or RR admin for global rows);
  // a blocked row simply updates nothing.
  const { error } = await supabase.from("partners").update(f).eq("id", id);
  if (error) redirect(`/partners?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/partners");
  redirect("/partners?saved=1");
}

export async function deletePartner(formData: FormData) {
  const profile = await requireRole(PARTNER_CREW);
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/partners?error=Missing+id");
  const supabase = await createClient();
  const { error } = await supabase
    .from("partners")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  if (error) redirect(`/partners?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/partners");
  redirect("/partners?saved=1");
}

/**
 * Copy a GLOBAL suggested partner into the current farm's directory (so it can then
 * be edited or invited). Owner/manager only.
 */
export async function adoptSuggested(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = String(formData.get("id") ?? "");
  if (!id || !profile.farm_id) redirect("/partners?error=No+farm");

  const supabase = await createClient();
  const { data: src } = await supabase
    .from("partners")
    .select("name, kind, phone, whatsapp, email, area, notes")
    .eq("id", id)
    .is("farm_id", null)
    .maybeSingle();
  if (!src) redirect("/partners?error=Suggested+partner+not+found");

  const { error } = await supabase.from("partners").insert({
    farm_id: profile.farm_id,
    is_suggested: false,
    name: src.name,
    kind: src.kind,
    phone: src.phone,
    whatsapp: src.whatsapp,
    email: src.email,
    area: src.area,
    notes: src.notes,
    created_by: profile.id,
  });
  if (error) redirect(`/partners?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/partners");
  redirect("/partners?saved=1");
}

// ── Invite / connect a contractor ────────────────────────────────────────────
// Turns a farm-owned partner into an authenticated, role-based `workshop`:
//   1. create (or reuse) a `workshop` carrying the partner's kind + contacts,
//   2. an ACTIVE `workshop_link` to this farm (the multi-farm access spine),
//   3. a `workshop`-role user for the contractor's email,
//   4. a magic login URL to hand over (deep-links straight into the app),
// then stamps partner.workshop_id. All privileged writes go through the service
// role (workshops/users are RR-admin-only under RLS) — exactly the 0-team pattern.
// RLS invariants are untouched: the contractor reaches ONLY farms with an active
// link to their workshop; no guessable bypass is created.

async function siteOrigin(): Promise<string> {
  return (
    (await headers()).get("origin") ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    ""
  );
}

/** Generate a magic login URL for an existing/created contractor user. */
async function issueLoginUrl(
  svc: ReturnType<typeof createServiceClient>,
  email: string,
  origin: string
): Promise<{ url: string | null; userId: string | null; error?: string }> {
  // Land the invited contractor on their aggregated contractor dashboard (F12c).
  const redirectTo = `${origin}/auth/callback?next=/contractor`;
  const { data, error } = await svc.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error || !data) return { url: null, userId: null, error: error?.message };
  const url = (data.properties as { action_link?: string } | null)?.action_link ?? null;
  return { url, userId: data.user?.id ?? null };
}

export async function inviteContractor(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const partnerId = String(formData.get("id") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!partnerId) redirect("/partners?error=Missing+partner");
  if (!email || !email.includes("@")) redirect("/partners?error=A+valid+email+is+required+to+invite");
  if (!profile.farm_id) redirect("/partners?error=No+farm");

  // Load the partner through RLS (guarantees it belongs to this farm).
  const rls = await createClient();
  const { data: partner } = await rls
    .from("partners")
    .select("id, farm_id, name, kind, phone, whatsapp, email, area, workshop_id")
    .eq("id", partnerId)
    .maybeSingle();
  if (!partner || partner.farm_id !== profile.farm_id) {
    redirect("/partners?error=Partner+not+found");
  }

  const svc = createServiceClient();
  const farmId = profile.farm_id;
  const name = partner.name as string;

  // 1) Workshop — reuse the linked one, or create it with the partner's classification.
  let workshopId = partner.workshop_id as string | null;
  if (workshopId) {
    await svc
      .from("workshops")
      .update({
        name,
        kind: partner.kind,
        phone: partner.phone,
        whatsapp: partner.whatsapp,
        email,
        area: partner.area,
      })
      .eq("id", workshopId);
  } else {
    const { data: ws, error: wErr } = await svc
      .from("workshops")
      .insert({
        name,
        kind: partner.kind,
        phone: partner.phone,
        whatsapp: partner.whatsapp,
        email,
        area: partner.area,
        contact: partner.phone ?? email,
      })
      .select("id")
      .single();
    if (wErr || !ws) redirect(`/partners?error=${encodeURIComponent(wErr?.message ?? "Could not create workshop")}`);
    workshopId = ws.id;
  }

  // 2) Active workshop_link farm ↔ workshop (idempotent; re-activate if revoked).
  const { data: existingLink } = await svc
    .from("workshop_links")
    .select("id, status")
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .maybeSingle();
  if (!existingLink) {
    const { error: lErr } = await svc
      .from("workshop_links")
      .insert({ workshop_id: workshopId, farm_id: farmId, status: "active" });
    if (lErr) redirect(`/partners?error=${encodeURIComponent(lErr.message)}`);
  } else if (existingLink.status !== "active") {
    await svc.from("workshop_links").update({ status: "active" }).eq("id", existingLink.id);
  }

  // 3) Contractor auth user (confirmed) + a workshop-role profile. createUser fails
  //    harmlessly if the email already exists; the magic link still works either way.
  const origin = await siteOrigin();
  const created = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { name },
  });
  const { url, userId, error: linkErr } = await issueLoginUrl(svc, email, origin);
  const uid = created.data?.user?.id ?? userId;
  if (uid) {
    const { data: prof } = await svc.from("users").select("id").eq("id", uid).maybeSingle();
    if (!prof) {
      await svc.from("users").insert({
        id: uid,
        workshop_id: workshopId,
        role: "workshop",
        name,
        email,
        active: true,
      });
    }
  }

  // 4) Stamp the partner with its workshop and hand back the login URL.
  await svc.from("partners").update({ workshop_id: workshopId }).eq("id", partnerId);

  revalidatePath("/partners");
  if (linkErr || !url) {
    redirect(`/partners?connected=1&pid=${partnerId}&linkerror=${encodeURIComponent(linkErr ?? "Login link unavailable")}`);
  }
  redirect(`/partners?connected=1&pid=${partnerId}&loginUrl=${encodeURIComponent(url)}`);
}

/** Re-issue a fresh magic login URL for an already-connected contractor. */
export async function sendLoginUrl(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const partnerId = String(formData.get("id") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!partnerId) redirect("/partners?error=Missing+partner");
  if (!email || !email.includes("@")) redirect("/partners?error=A+valid+email+is+required");

  const rls = await createClient();
  const { data: partner } = await rls
    .from("partners")
    .select("id, farm_id, workshop_id")
    .eq("id", partnerId)
    .maybeSingle();
  if (!partner || partner.farm_id !== profile.farm_id || !partner.workshop_id) {
    redirect("/partners?error=This+partner+is+not+connected+yet");
  }

  const svc = createServiceClient();
  const origin = await siteOrigin();
  const { url, error } = await issueLoginUrl(svc, email, origin);
  if (error || !url) {
    redirect(`/partners?connected=1&pid=${partnerId}&linkerror=${encodeURIComponent(error ?? "Login link unavailable")}`);
  }
  redirect(`/partners?connected=1&pid=${partnerId}&loginUrl=${encodeURIComponent(url)}`);
}
