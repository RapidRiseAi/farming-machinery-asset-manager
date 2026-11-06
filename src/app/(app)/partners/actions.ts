"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { homePathFor, requireProfile, requireUsableFarm } from "@/lib/auth";
import { farmPermissionState } from "@/lib/permissions";
import { mintSignIn, sendContractorSignIn } from "@/lib/email/partner-access";
import { siteUrl } from "@/lib/env";
import { inviteExpiry, inviteUrl, newInviteSecrets } from "@/lib/partner-invites";
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
  await requireUsableFarm(state.farmId, profile);
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
  await requireUsableFarm(state.farmId, profile);
  return { farmId: state.farmId, profile };
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

// == Giving a contractor access ===============================================
// The farmer makes a link and a code and sends them however they like; the contractor proves
// their own email address on /join (lib/partner-invites.ts has the rules). Connecting happens
// there, through the service role, exactly the 0-team pattern. RLS invariants are untouched:
// a contractor reaches only farms with an active link to their workshop.
//
// Nothing in this section ever gives a farmer a way to sign in as somebody. It used to: an
// address typed here was turned into a working sign-in link and shown on screen, for any
// account on the platform. A sign-in link now only ever goes by email to its own address.

function grantsFrom(fd: FormData) {
  return {
    see_all_vehicles: fd.get("see_all_vehicles") != null,
    see_service_history: fd.get("see_service_history") != null,
    see_costs: fd.get("see_costs") != null,
    see_team: fd.get("see_team") != null,
  };
}

/** Make a link for a contractor, adding them to the directory first if they are new. */
export async function createPartnerInvite(formData: FormData) {
  return runOnce(
    formData,
    "partners:access-link",
    async () => {
      const { farmId, profile } = await requireConnectionManager();
      const origin = siteUrl();
      if (!origin) redirect("/partners?linkerror=1");

      const rls = await createClient();
      let partnerId = String(formData.get("id") ?? "");
      if (partnerId) {
        // Through RLS: this is what proves the row is this farm's.
        const { data: partner, error } = await rls
          .from("partners")
          .select("id, farm_id")
          .eq("id", partnerId)
          .is("deleted_at", null)
          .maybeSingle();
        if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:createPartnerInvite:partner")}`);
        if (!partner || partner.farm_id !== farmId) redirect("/partners?error=Partner+not+found");
      } else {
        const name = s(formData, "name");
        if (!name) redirect("/partners?error=partner-name-needed");
        const { data: own, error: ownError } = await rls
          .from("partners")
          .select("id, name, phone")
          .eq("farm_id", farmId)
          .is("deleted_at", null);
        // Unread is not "no match": adding on it would file a duplicate contractor.
        if (ownError) redirect(`/partners?error=${errorCode(ownError, "app/partners/actions:createPartnerInvite:own")}`);
        const key = partnerMatchKey(name, null);
        const match = ((own ?? []) as { id: string; name: string; phone: string | null }[]).find(
          (p) => partnerMatchKey(p.name, null) === key,
        );
        if (match) {
          partnerId = match.id;
        } else {
          const { data: added, error } = await rls
            .from("partners")
            .insert({ farm_id: farmId, is_suggested: false, name, kind: kindOf(formData), created_by: profile.id })
            .select("id")
            .single();
          if (error || !added) redirect(`/partners?error=${errorCode(error, "app/partners/actions:createPartnerInvite:add", "partner-name-needed")}`);
          partnerId = added.id as string;
        }
      }

      const svc = createServiceClient();
      const { data: stamped, error: stampedError } = await svc
        .from("partners")
        .select("workshop_id")
        .eq("id", partnerId)
        .maybeSingle();
      if (stampedError) return `/partners?error=${errorCode(stampedError, "app/partners/actions:createPartnerInvite:stamped")}`;
      if (stamped?.workshop_id) {
        const { data: active, error: activeError } = await svc
          .from("workshop_links")
          .select("id")
          .eq("workshop_id", stamped.workshop_id)
          .eq("farm_id", farmId)
          .eq("status", "active")
          .is("deleted_at", null)
          .maybeSingle();
        if (activeError) return `/partners?error=${errorCode(activeError, "app/partners/actions:createPartnerInvite:active")}`;
        if (active) return "/partners?error=partner-connected";
      }

      // One live link per contractor, and a new one retires any earlier one, claimed or not.
      const now = new Date().toISOString();
      const { error: retireError } = await svc
        .from("partner_invites")
        .update({ revoked_at: now })
        .eq("partner_id", partnerId)
        .is("revoked_at", null);
      if (retireError) return `/partners?error=${errorCode(retireError, "app/partners/actions:createPartnerInvite:retire")}`;

      const secrets = newInviteSecrets();
      const { error: inviteError } = await svc.from("partner_invites").insert({
        farm_id: farmId,
        partner_id: partnerId,
        token_hash: secrets.tokenHash,
        code_hash: secrets.codeHash,
        ...grantsFrom(formData),
        expires_at: inviteExpiry(),
        created_by: profile.id,
      });
      if (inviteError) return `/partners?error=${errorCode(inviteError, "app/partners/actions:createPartnerInvite:insert")}`;

      // The only moment the link and code exist in the clear.
      await setPartnerLink({ pid: partnerId, url: inviteUrl(origin, secrets.token), code: secrets.code });
      revalidatePath("/partners");
      return "/partners";
    },
    { whileRunning: "/partners?error=still-saving" },
  );
}

/** Cancel a link nobody has used yet. */
export async function revokePartnerInvite(formData: FormData) {
  const { farmId } = await requireConnectionManager();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/partners?error=missing");

  const { error } = await createServiceClient()
    .from("partner_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("farm_id", farmId)
    .is("revoked_at", null);
  if (error) redirect(`/partners?error=${errorCode(error, "app/partners/actions:revokePartnerInvite")}`);

  await clearPartnerLink();
  revalidatePath("/partners");
  redirect("/partners?cancelled=1");
}

/**
 * Email a connected contractor a sign-in link. To the address on their own login: the farmer
 * chooses who, never where, and never sees the link.
 */
export async function emailPartnerSignIn(formData: FormData) {
  return runOnce(
    formData,
    "partners:sign-in-email",
    async () => {
      const { farmId, profile } = await requireConnectionManager();
      const partnerId = String(formData.get("id") ?? "");
      if (!partnerId) redirect("/partners?error=Missing+partner");

      const rls = await createClient();
      const { data: partner, error: partnerError } = await rls
        .from("partners")
        .select("id, farm_id, workshop_id")
        .eq("id", partnerId)
        .maybeSingle();
      if (partnerError) redirect(`/partners?error=${errorCode(partnerError, "app/partners/actions:emailPartnerSignIn")}`);
      if (!partner || partner.farm_id !== farmId || !partner.workshop_id) {
        redirect("/partners?error=This+partner+is+not+connected+yet");
      }

      const svc = createServiceClient();
      // A workshop on the partner is not a connection: a farm that has disconnected them
      // leaves the stamp without an active link, and a sign-in would open an empty account.
      const { data: activeLink, error: activeError } = await svc
        .from("workshop_links")
        .select("id")
        .eq("workshop_id", partner.workshop_id)
        .eq("farm_id", farmId)
        .eq("status", "active")
        .is("deleted_at", null)
        .maybeSingle();
      if (activeError) redirect(`/partners?error=${errorCode(activeError, "app/partners/actions:emailPartnerSignIn:link")}`);
      if (!activeLink) redirect("/partners?error=This+partner+is+not+connected+yet");

      const { data: login, error: loginError } = await svc
        .from("users")
        .select("email, name")
        .eq("workshop_id", partner.workshop_id)
        .eq("role", "workshop")
        .eq("active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (loginError) redirect(`/partners?error=${errorCode(loginError, "app/partners/actions:emailPartnerSignIn:login")}`);
      if (!login?.email) redirect("/partners?error=partner-no-login");

      const signIn = await mintSignIn(svc, login.email as string);
      if (!signIn.tokenHash) redirect("/partners?linkerror=1");

      const { data: farm, error: farmError } = await svc.from("farms").select("name").eq("id", farmId).maybeSingle();
      if (farmError) captureError(farmError, { where: "partners:sign-in-email:farm" });
      const mail = await sendContractorSignIn({
        email: login.email as string,
        name: (login.name as string | null) ?? "",
        farmId,
        farmName: (farm as { name?: string } | null)?.name ?? "",
        tokenHash: signIn.tokenHash,
        locale: profile.language,
      });
      if (!mail.ok) {
        captureError(new Error(`partners: sign-in email not sent (${mail.reason})`), { where: "partners:sign-in-email" });
        redirect("/partners?linkerror=1");
      }
      return "/partners?sent=1";
    },
    { whileRunning: "/partners?error=still-saving" },
  );
}

/**
 * Drop the pending link and code once the farmer has passed them on. The cookie expires on
 * its own after ten minutes; this is the explicit "I'm done with it" path, so they are not
 * sitting there while the phone is handed around a workshop.
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
