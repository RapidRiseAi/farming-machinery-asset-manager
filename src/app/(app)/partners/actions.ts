"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireRole, accessibleFarms } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { setPartnerLink, clearPartnerLink } from "@/lib/partner-link";

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
  // The login URL is a bearer credential — it never travels in a query string.
  await setPartnerLink({ pid: partnerId, url });
  redirect(`/partners?connected=1&pid=${partnerId}`);
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
  // The login URL is a bearer credential — it never travels in a query string.
  await setPartnerLink({ pid: partnerId, url });
  redirect(`/partners?connected=1&pid=${partnerId}`);
}


/**
 * Drop the pending login link once the farmer has passed it on. The cookie expires on
 * its own after ten minutes; this is the explicit "I'm done with it" path so the
 * credential is not sitting there while the phone is handed around a workshop.
 */
export async function dismissLoginUrl() {
  await requireRole(["owner", "manager"]);
  await clearPartnerLink();
  revalidatePath("/partners");
  redirect("/partners");
}

// ── A contractor asking to connect (F15) ─────────────────────────────────────
//
// The other half of the partner's client book. A partner can raise a PENDING
// `workshop_link` for a farm whose owner/manager's email they hold (0390 wl_ins_request);
// pending grants nothing, because `app.has_farm_access` counts only 'active'. These two
// actions are the only way it becomes real, and they belong to the farm.
//
// Approving is genuinely consequential — it hands a contractor read and write access to
// this farm's vehicles, faults, job cards and work requests — so the UI puts it behind a
// confirmation that names them, and this action re-checks the role rather than trusting
// the screen.

/*
 * Which farm this decision is about.
 *
 * NOT `profile.farm_id`: with multi-site (F7) an owner may be looking at their second
 * farm while their primary is still something else, so approving a request shown on
 * screen would have written against the wrong farm — updating nothing, and then running
 * the service-role client mutation against a farm that never approved anything.
 *
 * The form carries the farm the request was listed under; this re-derives access rather
 * than trusting it, so a hand-edited value cannot approve a link on a farm the caller
 * has no business in. RLS would refuse the write in any case; failing here makes it a
 * clear error rather than a silent no-op.
 */
async function decidingFarmId(formData: FormData, profile: { farm_id: string | null }): Promise<string> {
  const claimed = String(formData.get("farm_id") ?? "").trim();
  const farms = await accessibleFarms();
  const allowed = new Set(farms.map((f) => f.id));
  if (claimed && allowed.has(claimed)) return claimed;
  if (claimed && !allowed.has(claimed)) redirect("/partners?error=forbidden");
  if (profile.farm_id) return profile.farm_id;
  redirect("/partners?error=missing");
}

/** Approve a contractor's connection request: their pending link becomes active. */
export async function approveLinkRequest(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const workshopId = String(formData.get("workshop_id") ?? "");
  if (!workshopId) redirect("/partners?error=missing");
  const farmId = await decidingFarmId(formData, profile);

  const supabase = await createClient();
  const { error } = await supabase
    .from("workshop_links")
    .update({ status: "active" })
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .eq("status", "pending");
  if (error) redirect(`/partners?error=${encodeURIComponent(error.message)}`);

  /*
   * Bind the partner's own client record so their notes and notebook vehicles follow the
   * link through. Keyed on `requested_farm_id` (0392) — the farm the request was actually
   * aimed at. Before that column existed this matched EVERY unbound `requested` row for
   * the workshop and set them all to this farm, which violates the (workshop_id, farm_id)
   * unique index the moment a partner has two requests outstanding: the statement failed
   * as a whole, after the link had already gone active, and the error was swallowed.
   *
   * Service role because `partner_clients` is the partner's table and a farm user cannot
   * write it — but this farm's approval is precisely the event that makes the binding true.
   */
  const svc = createServiceClient();
  await svc
    .from("partner_clients")
    .update({ farm_id: farmId, link_status: "linked", linked_at: new Date().toISOString() })
    .eq("workshop_id", workshopId)
    .eq("requested_farm_id", farmId)
    .is("farm_id", null);

  revalidatePath("/partners");
  redirect("/partners?connected=1");
}

/** Decline it. The link is revoked (not deleted) so the history of the ask survives. */
export async function declineLinkRequest(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const workshopId = String(formData.get("workshop_id") ?? "");
  if (!workshopId) redirect("/partners?error=missing");
  const farmId = await decidingFarmId(formData, profile);

  const supabase = await createClient();
  await supabase
    .from("workshop_links")
    .update({ status: "revoked" })
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .eq("status", "pending");

  const svc = createServiceClient();
  await svc
    .from("partner_clients")
    .update({ link_status: "declined" })
    .eq("workshop_id", workshopId)
    .eq("requested_farm_id", farmId)
    .is("farm_id", null);

  revalidatePath("/partners");
  redirect("/partners?declined=1");
}
