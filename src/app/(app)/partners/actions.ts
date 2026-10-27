"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { homePathFor, requireProfile } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";
import { setPartnerLink, clearPartnerLink } from "@/lib/partner-link";
import { partnerMatchKey } from "@/lib/partner-match";
import { runOnce } from "@/lib/request-claim";
import { errorCode } from "@/lib/action-errors";
import { captureError } from "@/lib/observability";

async function requireDirectoryManager() {
  const profile = await requireProfile();
  if (profile.role === "rr_admin") {
    return { profile, farmId: null, isAdmin: true } as const;
  }
  const state = await farmPermissionState(profile);
  if (!state.farmId || !state.allows("manage_partners")) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { profile, farmId: state.farmId, isAdmin: false } as const;
}

/** Contractor connections carry broader access than directory editing, so the additive
 * `manage_partners` grant deliberately does not open this path. */
async function requireConnectionManager() {
  const profile = await requireProfile();
  const state = await farmPermissionState(profile);
  if (!state.farmId || !state.role || !["owner", "manager"].includes(state.role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  return { farmId: state.farmId };
}

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
  const { profile, farmId, isAdmin } = await requireDirectoryManager();
  const f = partnerFields(formData);
  if (!f.name) redirect("/partners?error=Name+is+required");

  // RR admin (no farm) curates the GLOBAL suggested catalogue (farm_id null,
  // is_suggested true); a farmer adds a row scoped to their own farm.
  const supabase = await createClient();
  const { error } = await supabase.from("partners").insert({
    farm_id: farmId,
    is_suggested: isAdmin,
    ...f,
    created_by: profile.id,
  });
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:createPartner")}`);
  revalidatePath("/partners");
  redirect("/partners?added=1");
}

export async function updatePartner(formData: FormData) {
  const { farmId, isAdmin } = await requireDirectoryManager();
  const id = String(formData.get("id") ?? "");
  const f = partnerFields(formData);
  if (!id || !f.name) redirect("/partners?error=Name+is+required");

  const supabase = await createClient();
  // RLS restricts this to the farm's owner/manager (or RR admin for global rows);
  // a blocked row simply updates nothing.
  let query = supabase.from("partners").update(f).eq("id", id);
  query = isAdmin ? query.is("farm_id", null) : query.eq("farm_id", farmId);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:updatePartner")}`);
  if (!data) redirect("/partners?error=Partner+not+found");
  revalidatePath("/partners");
  redirect("/partners?saved=1");
}

export async function deletePartner(formData: FormData) {
  const { profile, farmId, isAdmin } = await requireDirectoryManager();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/partners?error=Missing+id");
  const supabase = await createClient();
  let query = supabase
    .from("partners")
    .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
    .eq("id", id);
  query = isAdmin ? query.is("farm_id", null) : query.eq("farm_id", farmId);
  const { data, error } = await query.select("id").maybeSingle();
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:deletePartner")}`);
  if (!data) redirect("/partners?error=Partner+not+found");
  revalidatePath("/partners");
  redirect("/partners?removed=1");
}

/**
 * Copy a GLOBAL suggested partner into the current farm's directory (so it can then
 * be edited or invited). Owner/manager only.
 */
export async function adoptSuggested(formData: FormData) {
  const { profile, farmId, isAdmin } = await requireDirectoryManager();
  const id = String(formData.get("id") ?? "");
  if (!id || isAdmin || !farmId) redirect("/partners?error=No+farm");

  const supabase = await createClient();
  const { data: src, error: srcError } = await supabase
    .from("partners")
    .select("name, kind, phone, whatsapp, email, area, notes")
    .eq("id", id)
    .is("farm_id", null)
    .maybeSingle();
  if (srcError) redirect(`/partners?error=${errorCode(srcError, "app/partners/actions:adoptSuggested:source")}`);
  if (!src) redirect("/partners?error=Suggested+partner+not+found");

  // Already copied? The page hides the button for a match, and this refuses a second
  // tap (or a stale tab) rather than filing a duplicate contractor.
  const { data: own, error: ownError } = await supabase
    .from("partners")
    .select("name, phone")
    .eq("farm_id", farmId)
    .is("deleted_at", null);
  // A failed read is not "no match": copying on it would file the duplicate this check stops.
  if (ownError) redirect(`/partners?error=${errorCode(ownError, "app/partners/actions:adoptSuggested:own")}`);
  const srcKey = partnerMatchKey(src.name, src.phone);
  const ownRows = (own ?? []) as { name: string; phone: string | null }[];
  if (ownRows.some((p) => partnerMatchKey(p.name, p.phone) === srcKey)) {
    redirect("/partners?already=1");
  }

  const { error } = await supabase.from("partners").insert({
    farm_id: farmId,
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
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:adoptSuggested")}`);
  revalidatePath("/partners");
  redirect("/partners?added=1");
}

// == Invite / connect a contractor ============================================
// Turns a farm-owned partner into an authenticated, role-based `workshop`:
//   1. create (or reuse) a `workshop` carrying the partner's kind + contacts,
//   2. an ACTIVE `workshop_link` to this farm (the multi-farm access spine),
//   3. a `workshop`-role user for the contractor's email,
//   4. a magic login URL to hand over (deep-links straight into the app),
// then stamps partner.workshop_id. All privileged writes go through the service
// role (workshops/users are RR-admin-only under RLS), exactly the 0-team pattern.
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
  if (error || !data) {
    // Both callers say "no login link" to the farmer; we hear of it unless Auth refused the
    // request itself (a 4xx: a malformed address, too many emails). The status and code
    // only: GoTrue's message can quote the email address.
    const status = (error as { status?: number } | null)?.status;
    if (!(typeof status === "number" && status >= 400 && status < 500)) {
      captureError(new Error(`partners:login-link failed (${(error as { code?: string } | null)?.code ?? status ?? "no data"})`), { where: "partners:login-link" });
    }
    return { url: null, userId: null, error: error?.message };
  }
  const url = (data.properties as { action_link?: string } | null)?.action_link ?? null;
  return { url, userId: data.user?.id ?? null };
}

export async function inviteContractor(formData: FormData) {
  return runOnce(
    formData,
    "partners:invite",
    async () => {
      const { farmId } = await requireConnectionManager();
      const partnerId = String(formData.get("id") ?? "");
      const email = String(formData.get("email") ?? "").trim().toLowerCase();
      if (!partnerId) redirect("/partners?error=Missing+partner");
      if (!email || !email.includes("@")) redirect("/partners?error=A+valid+email+is+required+to+invite");

      // Load the partner through RLS (guarantees it belongs to this farm).
      const rls = await createClient();
      const { data: partner, error: partnerError } = await rls
        .from("partners")
        .select("id, farm_id, name, kind, phone, whatsapp, email, area, workshop_id")
        .eq("id", partnerId)
        .maybeSingle();
      if (partnerError) redirect(`/partners?error=${errorCode(partnerError, "app/partners/actions:inviteContractor:partner")}`);
      if (!partner || partner.farm_id !== farmId) {
        redirect("/partners?error=Partner+not+found");
      }

      const svc = createServiceClient();
      const name = partner.name as string;

      // 1) Workshop, reuse the linked one, or create it with the partner's classification.
      let workshopId = partner.workshop_id as string | null;
      if (workshopId) {
        const { error: refreshError } = await svc
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
        // Nothing new exists yet, so a redirect is safe: the retry runs this again.
        if (refreshError) redirect(`/partners?error=${errorCode(refreshError, "app/partners/actions:inviteContractor:workshop")}`);
      } else {
        // The new workshop takes the farm's test mark (20261014120000): a test farm's contractor
        // is a test workshop, which the fence then lets it link with.
        const { data: farmMark, error: markError } = await svc.from("farms").select("is_test").eq("id", farmId).maybeSingle();
        // A failed read would mark a test farm's contractor as real, across the fence.
        if (markError) redirect(`/partners?error=${errorCode(markError, "app/partners/actions:inviteContractor:test-mark")}`);
        const { data: ws, error: wErr } = await svc
          .from("workshops")
          .insert({
            is_test: (farmMark as { is_test?: boolean } | null)?.is_test === true,
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
        if (wErr || !ws) redirect(`/partners?error=${errorCode(wErr, "app/partners/actions:inviteContractor", "Could not create workshop")}`);
        workshopId = ws.id;
        // Stamped at once, before anything below can stop the run: an unstamped partner's
        // next "Connect" makes a second workshop for the same contractor, so every later
        // early return (an unread link, an unread profile) must find the stamp already done.
        const { error: stampError } = await svc.from("partners").update({ workshop_id: workshopId }).eq("id", partnerId);
        if (stampError) captureError(stampError, { where: "partners:invite:stamp" });
      }

      // 2) Active workshop_link farm ↔ workshop (idempotent; re-activate if revoked).
      const { data: existingLink, error: existingError } = await svc
        .from("workshop_links")
        .select("id, status")
        .eq("workshop_id", workshopId)
        .eq("farm_id", farmId)
        .maybeSingle();
      // The workshop may exist from here on: return, never redirect.
      if (existingError) return `/partners?error=${errorCode(existingError, "app/partners/actions:inviteContractor:link-read")}`;
      if (!existingLink) {
        const { error: lErr } = await svc
          .from("workshop_links")
          .insert({ workshop_id: workshopId, farm_id: farmId, status: "active" });
        // The workshop exists from here on: return (runOnce records it), never redirect.
        if (lErr) return `/partners?error=${errorCode(lErr, "app/partners/actions:inviteContractor")}`;
      } else if (existingLink.status !== "active") {
        const { error: reactivateError } = await svc.from("workshop_links").update({ status: "active" }).eq("id", existingLink.id);
        // Still revoked, the contractor would get a login to a farm they cannot see.
        if (reactivateError) return `/partners?error=${errorCode(reactivateError, "app/partners/actions:inviteContractor:reactivate")}`;
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
        const { data: prof, error: profReadError } = await svc.from("users").select("id").eq("id", uid).maybeSingle();
        // Unread is not "no profile": say the login could not be made, as for a failed insert.
        if (profReadError) {
          captureError(profReadError, { where: "partners:invite:profile-read" });
          revalidatePath("/partners");
          return "/partners?linkerror=1";
        }
        if (!prof) {
          const { error: profileError } = await svc.from("users").insert({
            id: uid,
            workshop_id: workshopId,
            role: "workshop",
            name,
            email,
            active: true,
          });
          // Without a profile the login link opens an account that is bounced straight back
          // to /login: the connection stands, but say the login could not be made.
          if (profileError) {
            captureError(profileError, { where: "partners:invite:profile" });
            revalidatePath("/partners");
            return "/partners?linkerror=1";
          }
        }
      }

      // 4) Hand back the login URL (the partner was stamped with its workshop in step 1).
      revalidatePath("/partners");
      // The connection stands either way; `linkerror` says only that no login link could be
      // made, and the page says so in the farmer's language rather than in Auth's.
      if (linkErr || !url) return "/partners?linkerror=1";
      // The login URL is a bearer credential, it never travels in a query string.
      await setPartnerLink({ pid: partnerId, url });
      return "/partners?connected=1";
    },
    { whileRunning: "/partners?error=still-saving" },
  );
}

/** Re-issue a fresh magic login URL for an already-connected contractor. */
export async function sendLoginUrl(formData: FormData) {
  return runOnce(
    formData,
    "partners:login-url",
    async () => {
      const { farmId } = await requireConnectionManager();
      const partnerId = String(formData.get("id") ?? "");
      const email = String(formData.get("email") ?? "").trim().toLowerCase();
      if (!partnerId) redirect("/partners?error=Missing+partner");
      if (!email || !email.includes("@")) redirect("/partners?error=A+valid+email+is+required");

      const rls = await createClient();
      const { data: partner, error: partnerError } = await rls
        .from("partners")
        .select("id, farm_id, workshop_id")
        .eq("id", partnerId)
        .maybeSingle();
      if (partnerError) redirect(`/partners?error=${errorCode(partnerError, "app/partners/actions:sendLoginUrl")}`);
      if (!partner || partner.farm_id !== farmId || !partner.workshop_id) {
        redirect("/partners?error=This+partner+is+not+connected+yet");
      }

      const svc = createServiceClient();
      // A workshop on the partner is not a connection: an invite that stopped after making
      // the workshop (its link or the contractor's profile failed), or a farm that has since
      // disconnected them, leaves the stamp without an active link. A login link then opens
      // an account that can see nothing, so the farmer is sent back to the invite instead,
      // which finishes the connection and reuses the workshop.
      const { data: activeLink, error: activeError } = await svc
        .from("workshop_links")
        .select("id")
        .eq("workshop_id", partner.workshop_id)
        .eq("farm_id", farmId)
        .eq("status", "active")
        .is("deleted_at", null)
        .maybeSingle();
      if (activeError) redirect(`/partners?error=${errorCode(activeError, "app/partners/actions:sendLoginUrl:link")}`);
      if (!activeLink) redirect("/partners?error=This+partner+is+not+connected+yet");

      const origin = await siteOrigin();
      const { url, error } = await issueLoginUrl(svc, email, origin);
      if (error || !url) redirect("/partners?linkerror=1");
      // The login URL is a bearer credential, it never travels in a query string.
      await setPartnerLink({ pid: partnerId, url });
      // `sent`, not `connected`: they were connected already, this is only a fresh link.
      return "/partners?sent=1";
    },
    { whileRunning: "/partners?error=still-saving" },
  );
}


/**
 * Drop the pending login link once the farmer has passed it on. The cookie expires on
 * its own after ten minutes; this is the explicit "I'm done with it" path so the
 * credential is not sitting there while the phone is handed around a workshop.
 */
export async function dismissLoginUrl() {
  await requireConnectionManager();
  await clearPartnerLink();
  revalidatePath("/partners");
  redirect("/partners");
}

// == A contractor asking to connect (F15) =====================================
//
// The other half of the partner's client book. A partner can raise a PENDING
// `workshop_link` for a farm whose owner/manager's email they hold (0390 wl_ins_request);
// pending grants nothing, because `app.has_farm_access` counts only 'active'. These two
// actions are the only way it becomes real, and they belong to the farm.
//
// Approving is genuinely consequential, it hands a contractor read and write access to
// this farm's vehicles, faults, job cards and work requests, so the UI puts it behind a
// confirmation that names them, and this action re-checks the role rather than trusting
// the screen.

/*
 * Which farm this decision is about.
 *
 * NOT `profile.farm_id`: with multi-site (F7) an owner may be looking at their second
 * farm while their primary is still something else, so approving a request shown on
 * screen would have written against the wrong farm, updating nothing, and then running
 * the service-role client mutation against a farm that never approved anything.
 *
 * The form carries the farm the request was listed under; this re-derives access rather
 * than trusting it, so a hand-edited value cannot approve a link on a farm the caller
 * has no business in. RLS would refuse the write in any case; failing here makes it a
 * clear error rather than a silent no-op.
 */
/** Approve a contractor's connection request: their pending link becomes active. */
export async function approveLinkRequest(formData: FormData) {
  const { farmId } = await requireConnectionManager();
  const workshopId = String(formData.get("workshop_id") ?? "");
  if (!workshopId) redirect("/partners?error=missing");

  const supabase = await createClient();
  const { error } = await supabase
    .from("workshop_links")
    .update({ status: "active" })
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .eq("status", "pending");
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:approveLinkRequest")}`);

  /*
   * Bind the partner's own client record so their notes and notebook vehicles follow the
   * link through. Keyed on `requested_farm_id` (0392), the farm the request was actually
   * aimed at. Before that column existed this matched EVERY unbound `requested` row for
   * the workshop and set them all to this farm, which violates the (workshop_id, farm_id)
   * unique index the moment a partner has two requests outstanding: the statement failed
   * as a whole, after the link had already gone active, and the error was swallowed.
   *
   * Service role because `partner_clients` is the partner's table and a farm user cannot
   * write it, but this farm's approval is precisely the event that makes the binding true.
   */
  const svc = createServiceClient();
  const { error: bindError } = await svc
    .from("partner_clients")
    .update({ farm_id: farmId, link_status: "linked", linked_at: new Date().toISOString() })
    .eq("workshop_id", workshopId)
    .eq("requested_farm_id", farmId)
    .is("farm_id", null);
  // Reported, not swallowed. The link is active either way and the request has left the
  // farmer's screen, so a "try again" would offer a retry that is not there.
  if (bindError) captureError(bindError, { where: "partners:approve:bind" });

  revalidatePath("/partners");
  // `accepted`, not `connected`: no login link follows an approval, and the invite's
  // "share the login link below" would promise one.
  redirect("/partners?accepted=1");
}

/** Decline it. The link is revoked (not deleted) so the history of the ask survives. */
export async function declineLinkRequest(formData: FormData) {
  const { farmId } = await requireConnectionManager();
  const workshopId = String(formData.get("workshop_id") ?? "");
  if (!workshopId) redirect("/partners?error=missing");

  const supabase = await createClient();
  const { error } = await supabase
    .from("workshop_links")
    .update({ status: "revoked" })
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .eq("status", "pending");
  // Unrevoked, the request is still there to be approved: "declined" would be false.
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:declineLinkRequest")}`);

  const svc = createServiceClient();
  const { error: markError } = await svc
    .from("partner_clients")
    .update({ link_status: "declined" })
    .eq("workshop_id", workshopId)
    .eq("requested_farm_id", farmId)
    .is("farm_id", null);
  // The decline itself stands and has left the screen; we hear that the partner's own
  // record still reads as asked.
  if (markError) captureError(markError, { where: "partners:decline:mark" });

  revalidatePath("/partners");
  redirect("/partners?declined=1");
}

// == What a connected contractor may see (F16 / 0400) =========================
//
// An active link is permission to do a JOB, not a key to the farm. These four grants
// are the farm's to give, they default to off, and each opens exactly its own slice -
// the database enforces that (app.partner_scope / app.partner_machine_visible), so this
// action only has to record the choice.
//
// There is deliberately NO grant for the farm's other contractors. A partner reading
// that list is reading a competitor directory with phone numbers, and no amount of
// consent makes it part of fixing a tractor.
export async function setPartnerAccess(formData: FormData) {
  const { farmId } = await requireConnectionManager();
  const workshopId = String(formData.get("workshop_id") ?? "");
  if (!workshopId) redirect("/partners?error=missing");

  const supabase = await createClient();
  const { error } = await supabase
    .from("workshop_links")
    .update({
      see_all_vehicles: formData.get("see_all_vehicles") != null,
      see_service_history: formData.get("see_service_history") != null,
      see_costs: formData.get("see_costs") != null,
      see_team: formData.get("see_team") != null,
    })
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId)
    .eq("status", "active");

  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:setPartnerAccess")}`);
  revalidatePath("/partners");
  // `saved=access`: `access` alone is not a result word the Flash clears.
  redirect("/partners?saved=access");
}

/** Disconnect a contractor. The link is revoked, so access stops immediately. */
export async function revokePartnerAccess(formData: FormData) {
  const { farmId } = await requireConnectionManager();
  const workshopId = String(formData.get("workshop_id") ?? "");
  if (!workshopId) redirect("/partners?error=missing");

  const supabase = await createClient();
  const { error } = await supabase
    .from("workshop_links")
    .update({ status: "revoked" })
    .eq("workshop_id", workshopId)
    .eq("farm_id", farmId);
  // "Disconnected" over a failed revoke would leave a contractor with access the farmer
  // believes is gone.
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:revokePartnerAccess")}`);

  revalidatePath("/partners");
  redirect("/partners?disconnected=1");
}
